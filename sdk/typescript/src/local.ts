import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
import { canonicalizeConnectPayload, fingerprintConnectPayload } from "./connect/binding.js";

type JsonObject = Record<string, unknown>;

type LocalStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint };
};

type LocalDatabase = {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): LocalStatement;
  close(): void;
};

type DatabaseSyncConstructor = new (
  location: string,
  options?: Readonly<{ timeout?: number; readOnly?: boolean }>,
) => LocalDatabase;

type StateFileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}>;

export type LocalLedgerMode = "create-if-missing" | "existing";

const LOCAL_STATE_SCHEMA = "CREATE TABLE IF NOT EXISTS local_operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('CLAIMED','UNKNOWN','CONFIRMED')), result_json TEXT, owner TEXT, lease_until INTEGER);";

const MANAGED_LEDGER_SCHEMA = `
  CREATE TABLE local_ledger_policy (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    witness_id TEXT
  );
  CREATE TABLE local_intent_approvals (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    label TEXT,
    assigned_to TEXT,
    approved_at INTEGER NOT NULL
  );
  CREATE TABLE local_operation_history (
    id TEXT PRIMARY KEY,
    claimed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    evidence TEXT NOT NULL,
    last_lookup TEXT,
    last_lookup_at INTEGER
  );
  CREATE TRIGGER local_operation_claimed AFTER INSERT ON local_operations
  BEGIN
    INSERT INTO local_operation_history VALUES (
      NEW.id, unixepoch('subsec') * 1000, unixepoch('subsec') * 1000, 'claim', NULL, NULL
    );
  END;
  CREATE TRIGGER local_operation_observed AFTER UPDATE OF state ON local_operations
  WHEN NEW.state != OLD.state
  BEGIN
    UPDATE local_operation_history SET updated_at = unixepoch('subsec') * 1000,
      evidence = CASE
        WHEN NEW.state = 'UNKNOWN' THEN 'outcome_unknown'
        WHEN OLD.state = 'UNKNOWN' THEN 'provider_reconciliation'
        ELSE 'execution_receipt'
      END,
      last_lookup = CASE WHEN OLD.state = 'UNKNOWN' AND NEW.state = 'CONFIRMED'
        THEN 'CONFIRMED' ELSE last_lookup END,
      last_lookup_at = CASE WHEN OLD.state = 'UNKNOWN' AND NEW.state = 'CONFIRMED'
        THEN unixepoch('subsec') * 1000 ELSE last_lookup_at END
    WHERE id = NEW.id;
  END;
`;

export interface LocalAdmissionWitness {
  readonly id: string;
  /**
   * Atomically and durably reserve this operation once in an independent
   * authority. Return true only for the call that made the first reservation.
   * Repeated calls, including after an ambiguous reply, must return false.
   */
  reserve(operationId: string, fingerprint: string): Promise<boolean>;
}

export type LocalObservation<T> =
  | { state: "CONFIRMED"; result: T }
  | { state: "ABSENT" | "UNKNOWN" };

export interface LocalProtectionOptions<A extends unknown[], T> {
  /** Stable identity of one intended external effect, shared by every retry. */
  id: (...args: A) => string;
  /** Complete effect-bearing plain-data payload. Exclude transport-only values. */
  payload: (...args: A) => JsonObject;
  /** Absolute or project-relative path. Defaults to .once/operations.sqlite. */
  statePath?: string;
  /** Require a pre-provisioned ledger and leave missing state untouched. */
  ledgerMode?: LocalLedgerMode;
  /** Authoritative provider lookup. It must never infer ABSENT from a timeout. */
  reconcile?: (context: { id: string; payload: JsonObject }) => Promise<LocalObservation<T>> | LocalObservation<T>;
  /** Time before an abandoned claim can be reconciled. No redispatch follows ABSENT. */
  leaseMs?: number;
}

export class LocalProtectionError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalProtectionError";
  }
}

type Row = {
  fingerprint: string;
  state: "CLAIMED" | "UNKNOWN" | "CONFIRMED";
  result_json: string | null;
  owner: string | null;
  lease_until: number | null;
};

function resolvedStatePath(value?: string): string {
  return path.resolve(value ?? path.join(process.cwd(), ".once", "operations.sqlite"));
}

function assertSupportedLocalRuntime(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new LocalProtectionError("UNSUPPORTED_RUNTIME", "Local SQLite protection requires Node.js 24.15 or later. Use a supported Node runtime or the hosted Once execution path.");
  }
}

async function loadDatabaseSync(): Promise<DatabaseSyncConstructor> {
  assertSupportedLocalRuntime();
  try {
    const sqlite = await import("node:sqlite");
    return sqlite.DatabaseSync as unknown as DatabaseSyncConstructor;
  } catch (cause) {
    throw new LocalProtectionError("SQLITE_UNAVAILABLE", "Node SQLite is unavailable. Enable node:sqlite or use the hosted Once execution path; the operation was not dispatched.", { cause });
  }
}

async function openLocalDatabase(
  statePath: string,
  mode: LocalLedgerMode | "read-only" = "create-if-missing",
): Promise<LocalDatabase> {
  const DatabaseSync = await loadDatabaseSync();
  let db: LocalDatabase | undefined;
  try {
    if (mode === "create-if-missing") {
      mkdirSync(path.dirname(statePath), { recursive: true });
      db = new DatabaseSync(statePath, { timeout: 30_000 });
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; ${LOCAL_STATE_SCHEMA}`);
    } else {
      if (!statSync(statePath).isFile()) throw new Error("Ledger must be a file.");
      const url = pathToFileURL(statePath);
      url.searchParams.set("mode", mode === "read-only" ? "ro" : "rw");
      db = new DatabaseSync(url.href, { timeout: 30_000, readOnly: mode === "read-only" });
      const operations = db.prepare("SELECT type FROM sqlite_schema WHERE name='local_operations'").get() as { type?: string } | undefined;
      if (operations?.type !== "table") throw new Error("Missing operations table.");
      db.prepare("SELECT id,fingerprint,state,result_json,owner,lease_until FROM local_operations LIMIT 0").get();
      if (mode === "existing") db.exec("PRAGMA synchronous=FULL");
    }
    return db;
  } catch (cause) {
    if (db) {
      try { db.close(); } catch { /* Preserve the initialization error. */ }
    }
    throw new LocalProtectionError("STATE_UNAVAILABLE", `Cannot open durable Once state at ${statePath}. The operation was not dispatched. Restore access to this same file before retrying.`, { cause });
  }
}

/** Create a new local authority explicitly. Never overwrites existing state. */
export async function provisionLocalLedger(
  statePath: string,
  options?: { witnessId?: string },
): Promise<void> {
  if (typeof statePath !== "string" || !statePath.trim()) {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "An explicit new ledger path is required.");
  }
  const witnessId = options?.witnessId;
  if (witnessId !== undefined && (typeof witnessId !== "string" || !witnessId.trim())) {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "A nonempty witness ID is required.");
  }
  const DatabaseSync = await loadDatabaseSync();
  const filename = path.resolve(statePath);
  let db: LocalDatabase | undefined;
  try {
    mkdirSync(path.dirname(filename), { recursive: true });
    closeSync(openSync(filename, "wx", 0o600));
    const url = pathToFileURL(filename);
    url.searchParams.set("mode", "rw");
    db = new DatabaseSync(url.href, { timeout: 30_000 });
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      BEGIN IMMEDIATE; ${LOCAL_STATE_SCHEMA} ${MANAGED_LEDGER_SCHEMA}`);
    db.prepare("INSERT INTO local_ledger_policy VALUES(1,?)").run(witnessId ?? null);
    db.exec("COMMIT");
  } catch (cause) {
    throw new LocalProtectionError("STATE_UNAVAILABLE", "Could not provision a new ledger. Preserve any existing ledger and its execution history.", { cause });
  } finally {
    db?.close();
  }
}

type LocalApproval = { fingerprint: string; label: string | null; assigned_to: string | null; approved_at: number };

function readApproval(db: LocalDatabase, id: string): LocalApproval | undefined {
  return db.prepare("SELECT fingerprint,label,assigned_to,approved_at FROM local_intent_approvals WHERE id=?")
    .get(id) as LocalApproval | undefined;
}

/** Internal host-only record; operation identity and effect must be supplied by trusted code. */
export async function recordLocalApproval(
  statePath: string,
  id: string,
  fingerprint: string,
  label: string | undefined,
  assignedTo: string | undefined,
): Promise<void> {
  const db = await openLocalDatabase(path.resolve(statePath), "existing");
  try {
    db.exec("BEGIN IMMEDIATE");
    const prior = readApproval(db, id);
    if (prior && prior.fingerprint !== fingerprint) {
      throw new LocalProtectionError("CONFLICT", "This approved intent is already bound to a different effect. A changed effect requires a separately authorised intent.");
    }
    if (!prior) {
      db.prepare("INSERT INTO local_intent_approvals(id,fingerprint,label,assigned_to,approved_at) VALUES (?,?,?,?,?)")
        .run(id, fingerprint, label ?? null, assignedTo ?? null, Date.now());
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export type LocalOperationStatus = Readonly<{
  operationId: string;
  state: "NOT_RECORDED" | "APPROVED" | "IN_FLIGHT" | "UNKNOWN" | "CONFIRMED";
  effectFingerprint: string | null;
  label: string | null;
  assignedTo: string | null;
  approvedAt: number | null;
  claimedAt: number | null;
  updatedAt: number | null;
  leaseUntil: number | null;
  lastLookup: "UNKNOWN" | "NOT_FOUND" | "UNAVAILABLE" | "INVALID" | "CONFIRMED" | null;
  lastLookupAt: number | null;
  evidence: "none" | "host_approval" | "claim" | "outcome_unknown" |
    "execution_receipt" | "provider_reconciliation" | "stored_receipt";
}>;

type OperationStatusRow = Pick<Row, "fingerprint" | "state" | "lease_until">;
type OperationHistory = {
  claimed_at: number;
  updated_at: number;
  evidence: LocalOperationStatus["evidence"];
  last_lookup: LocalOperationStatus["lastLookup"];
  last_lookup_at: number | null;
};

function statusFromLedger(db: LocalDatabase, operationId: string, managed: boolean, now: number): LocalOperationStatus {
  const approval = managed ? readApproval(db, operationId) : undefined;
  const row = db.prepare("SELECT fingerprint,state,lease_until FROM local_operations WHERE id=?")
    .get(operationId) as OperationStatusRow | undefined;
  const history = managed ? db.prepare("SELECT claimed_at,updated_at,evidence,last_lookup,last_lookup_at FROM local_operation_history WHERE id=?")
    .get(operationId) as OperationHistory | undefined : undefined;
  if ((approval && row && approval.fingerprint !== row.fingerprint) ||
      (row && row.state !== "CLAIMED" && row.state !== "UNKNOWN" && row.state !== "CONFIRMED")) {
    throw new LocalProtectionError("STATE_UNAVAILABLE", "The ledger contains inconsistent operation state.");
  }

  const state = !row ? (approval ? "APPROVED" : "NOT_RECORDED")
    : row.state === "CLAIMED" ? ((row.lease_until ?? 0) > now ? "IN_FLIGHT" : "UNKNOWN")
    : row.state;
  const evidence = state === "APPROVED" ? "host_approval"
    : state === "CONFIRMED" ? (history?.evidence ?? "stored_receipt")
    : state === "UNKNOWN" ? "outcome_unknown"
    : state === "IN_FLIGHT" ? "claim"
    : "none";
  return {
    operationId, state, evidence,
    effectFingerprint: row?.fingerprint ?? approval?.fingerprint ?? null,
    label: approval?.label ?? null,
    assignedTo: approval?.assigned_to ?? null,
    approvedAt: approval?.approved_at ?? null,
    claimedAt: history?.claimed_at ?? null,
    updatedAt: history?.updated_at ?? null,
    leaseUntil: row?.lease_until ?? null,
    lastLookup: history?.last_lookup ?? null,
    lastLookupAt: history?.last_lookup_at ?? null,
  };
}

async function inspectLedger<T>(
  statePath: string | undefined,
  inspect: (db: LocalDatabase, managed: boolean, now: number) => T,
): Promise<T> {
  const db = await openLocalDatabase(resolvedStatePath(statePath), "read-only");
  try {
    db.exec("BEGIN");
    const managed = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='local_intent_approvals'").get());
    const result = inspect(db, managed, Date.now());
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}

/** Inspect one local operation. No application code, provider calls or ledger transitions. */
export async function readLocalOperationStatus(operationId: string, statePath?: string): Promise<LocalOperationStatus> {
  if (typeof operationId !== "string" || !operationId.trim()) {
    throw new LocalProtectionError("INVALID_ID", "A nonempty operation ID is required.");
  }
  return inspectLedger(statePath, (db, managed, now) => statusFromLedger(db, operationId, managed, now));
}

/** Inspect up to 100 unresolved operations from a consistent local ledger snapshot. */
export async function listUnresolvedLocalOperations(
  options?: { statePath?: string; limit?: number; afterId?: string },
): Promise<LocalOperationStatus[]> {
  const { statePath, limit = 25, afterId } = options ?? {};
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (afterId !== undefined && (typeof afterId !== "string" || !afterId.trim()))) {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "Use a limit of 1–100 and, if specified, a nonempty operation cursor.");
  }
  return inspectLedger(statePath, (db, managed, now) => {
    const query = "SELECT id FROM local_operations WHERE (state='UNKNOWN' OR (state='CLAIMED' AND lease_until<=?))";
    const rows = afterId === undefined
      ? db.prepare(query + " ORDER BY id LIMIT ?").all(now, limit)
      : db.prepare(query + " AND id>? ORDER BY id LIMIT ?").all(now, afterId, limit);
    return (rows as { id: string }[]).map(row => statusFromLedger(db, row.id, managed, now));
  });
}

function stateFileIdentity(statePath: string): StateFileIdentity {
  const state = statSync(statePath, { bigint: true });
  return Object.freeze({
    dev: state.dev,
    ino: state.ino,
    birthtimeNs: state.birthtimeNs,
  });
}

function sameStateFile(a: StateFileIdentity, b: StateFileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

/**
 * Explicit reusable durable-state session for a long-lived execution boundary.
 * It keeps WAL/FULL durability and the same protectLocal state machine while
 * avoiding repeated SQLite open/setup cost. The path identity is checked before
 * every protected call; disappearance/replacement permanently invalidates the
 * session so an open handle can never silently mask loss of the reviewed state.
 */
export class LocalProtectionSession {
  readonly statePath: string;
  #db: LocalDatabase | undefined;
  #identity: StateFileIdentity | undefined;
  #opening: Promise<LocalDatabase> | undefined;
  #closed = false;

  constructor(statePath?: string) {
    this.statePath = resolvedStatePath(statePath);
  }

  async databaseForCall(): Promise<LocalDatabase> {
    if (this.#closed) {
      throw new LocalProtectionError("STATE_UNAVAILABLE", `Durable Once state session for ${this.statePath} is closed or invalid. Restart the execution boundary before retrying; no operation was dispatched.`);
    }

    if (this.#db) {
      this.assertStateIdentity();
      return this.#db;
    }

    if (!this.#opening) {
      this.#opening = (async () => {
        const db = await openLocalDatabase(this.statePath);
        let identity: StateFileIdentity;
        try {
          identity = stateFileIdentity(this.statePath);
        } catch (cause) {
          try { db.close(); } catch { /* Preserve state identity failure. */ }
          throw new LocalProtectionError("STATE_UNAVAILABLE", `Cannot verify durable Once state at ${this.statePath}. No operation was dispatched.`, { cause });
        }
        if (this.#closed) {
          try { db.close(); } catch { /* Session close is authoritative. */ }
          throw new LocalProtectionError("STATE_UNAVAILABLE", `Durable Once state session for ${this.statePath} was closed during initialization. No operation was dispatched.`);
        }
        this.#db = db;
        this.#identity = identity;
        return db;
      })().finally(() => {
        this.#opening = undefined;
      });
    }

    return this.#opening;
  }

  assertStateIdentity(): void {
    if (this.#closed) {
      throw new LocalProtectionError("STATE_UNAVAILABLE", `Durable Once state session for ${this.statePath} is closed or invalid. Restart the execution boundary before retrying; no operation was dispatched.`);
    }
    if (!this.#db || !this.#identity) return;

    let current: StateFileIdentity;
    try {
      current = stateFileIdentity(this.statePath);
    } catch (cause) {
      this.invalidate();
      throw new LocalProtectionError("STATE_UNAVAILABLE", `Durable Once state at ${this.statePath} disappeared while the execution boundary was live. The boundary is invalidated; no operation was dispatched.`, { cause });
    }

    if (!sameStateFile(this.#identity, current)) {
      this.invalidate();
      throw new LocalProtectionError("STATE_UNAVAILABLE", `Durable Once state at ${this.statePath} was replaced while the execution boundary was live. The boundary is invalidated; no operation was dispatched.`);
    }
  }

  invalidate(): void {
    this.#closed = true;
    const db = this.#db;
    this.#db = undefined;
    this.#identity = undefined;
    if (db) {
      try { db.close(); } catch { /* Invalidated state stays fail-closed. */ }
    }
  }

  close(): void {
    this.invalidate();
  }
}

const localProtectionSessionContext = new AsyncLocalStorage<LocalProtectionSession>();

export function createLocalProtectionSession(statePath?: string): LocalProtectionSession {
  return new LocalProtectionSession(statePath);
}

/** Scope one explicit shared session to the protected calls started by callback. */
export function withLocalProtectionSession<T>(
  session: LocalProtectionSession,
  callback: () => T,
): T {
  if (!(session instanceof LocalProtectionSession)) {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "withLocalProtectionSession requires a LocalProtectionSession created by this SDK instance.");
  }
  return localProtectionSessionContext.run(session, callback);
}

// Local mode accepts JSON-like data with no hidden behavior. Callable/provider
// handles may travel through arguments by identity, but cannot be payloads or
// receipts. The caller must keep their effect-bearing state stable.
function copyData(value: unknown, allowHandles = false, seen = new Set<object>(), location = "$", freeze = false): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (allowHandles && (value === undefined || typeof value === "bigint" || typeof value === "symbol")) return value;
  if (allowHandles && typeof value === "function") return value;
  if (typeof value !== "object") {
    throw new LocalProtectionError("UNSUPPORTED_VALUE", `Unsupported local data at ${location}.`);
  }
  if (types.isProxy(value)) {
    throw new LocalProtectionError("UNSUPPORTED_VALUE", `Proxy at ${location} is unsupported.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
    if (allowHandles) return value;
    throw new LocalProtectionError("UNSUPPORTED_VALUE", `Unsupported object at ${location}.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.includes("toJSON")) {
    throw new LocalProtectionError("UNSUPPORTED_VALUE", `Serialization hook at ${location} is unsupported.`);
  }
  if (keys.some(key => typeof key === "symbol")) {
    throw new LocalProtectionError("UNSUPPORTED_VALUE", `Symbol property at ${location} is unsupported.`);
  }
  if (keys.some(key => !("value" in descriptors[key as string]) ||
      (!(Array.isArray(value) && key === "length") && !descriptors[key as string].enumerable))) {
    throw new LocalProtectionError("UNSUPPORTED_VALUE", `Accessor or hidden property at ${location} is unsupported.`);
  }
  if (allowHandles && !Array.isArray(value) &&
      keys.some(key => typeof descriptors[key as string].value === "function")) return value;
  if (seen.has(value)) {
    throw new LocalProtectionError("UNSUPPORTED_VALUE", `Cyclic local data at ${location} is unsupported.`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        throw new LocalProtectionError("UNSUPPORTED_VALUE", `Unsupported array at ${location}.`);
      }
      const array = value as unknown[];
      if (keys.length !== array.length + 1 ||
          Array.from({ length: array.length }, (_, index) => String(index))
            .some(index => !Object.prototype.hasOwnProperty.call(descriptors, index))) {
        throw new LocalProtectionError("UNSUPPORTED_VALUE", `Sparse or extended array at ${location} is unsupported.`);
      }
      const result = array.map((_, index) => copyData(descriptors[String(index)].value, allowHandles, seen, `${location}[${index}]`, freeze));
      return freeze ? Object.freeze(result) : result;
    }
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      Object.defineProperty(result, key, {
        value: copyData(descriptors[key].value, allowHandles, seen, `${location}.${key}`, freeze),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return freeze ? Object.freeze(result) : result;
  } finally {
    seen.delete(value);
  }
}

/** Internal strict snapshot shared by explicit tool-call protection. */
export function snapshotLocalData<T>(value: T): T {
  return copyData(value, false, new Set<object>(), "$", true) as T;
}

function encodeResult(value: unknown): string {
  const envelope = value === undefined
    ? { hasValue: false }
    : { hasValue: true, value: copyData(value) };
  return canonicalizeConnectPayload(envelope);
}

function decodeResult<T>(encoded: string): T {
  try {
    const envelope = JSON.parse(encoded) as { hasValue?: unknown; value?: T };
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope) ||
        typeof envelope.hasValue !== "boolean" ||
        (envelope.hasValue && !Object.prototype.hasOwnProperty.call(envelope, "value")) ||
        (!envelope.hasValue && Object.prototype.hasOwnProperty.call(envelope, "value")) ||
        Object.keys(envelope).length !== (envelope.hasValue ? 2 : 1)) {
      throw new Error("Malformed receipt envelope.");
    }
    const validated = copyData(envelope) as { hasValue: boolean; value?: T };
    return (validated.hasValue ? validated.value : undefined) as T;
  } catch (cause) {
    throw new LocalProtectionError("STATE_UNAVAILABLE", "The stored local receipt is malformed. No operation was dispatched.", { cause });
  }
}

/**
 * Protect an existing async operation on one machine while keeping its call
 * shape and dynamic receiver. Ordinary data arguments are snapshotted and
 * frozen; opaque handles keep their identity. SQLite coordinates processes
 * sharing the same durable local file.
 * Uncertain outcomes remain blocked; this wrapper never redispatches after
 * an ambiguous attempt, even if a lookup reports ABSENT.
 */
export function protectLocal<A extends unknown[], T>(
  operation: (...args: A) => Promise<T>,
  options: LocalProtectionOptions<A, T>,
): (...args: A) => Promise<T> {
  return runLocalOperation(operation, options, "execute");
}

export function runLocalOperation<A extends unknown[], T>(
  operation: ((...args: A) => Promise<T>) | undefined,
  options: LocalProtectionOptions<A, T> & { witness?: LocalAdmissionWitness },
  mode: "execute" | "approved" | "reconcile" | "reconcile-approved",
): (...args: A) => Promise<T> {
  const reconcileOnly = mode === "reconcile" || mode === "reconcile-approved";
  const requireApproval = mode === "approved" || mode === "reconcile-approved";
  if ((!reconcileOnly && typeof operation !== "function") || typeof options?.id !== "function" || typeof options.payload !== "function") {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "protectLocal requires an async operation plus id and payload functions. The id must survive retries; payload must include every effect-bearing input.");
  }
  const statePath = resolvedStatePath(options.statePath);
  const ledgerMode = mode !== "execute" ? "existing" : options.ledgerMode ?? "create-if-missing";
  if (ledgerMode !== "create-if-missing" && ledgerMode !== "existing") {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "Invalid local ledger mode.");
  }
  const witnessId = options.witness?.id;
  const witness = typeof options.witness?.reserve === "function"
    ? options.witness.reserve.bind(options.witness) : undefined;
  if (options.witness !== undefined && (!witness || typeof witnessId !== "string" || !witnessId.trim() || ledgerMode !== "existing")) {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "An admission witness requires a reserve function and an existing ledger.");
  }
  const leaseMs = options.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new LocalProtectionError("INVALID_LEASE", "leaseMs must be a positive integer in milliseconds.");
  }

  return async function (this: unknown, ...args: A): Promise<T> {
    const callArgs = copyData(args, true, new Set<object>(), "$args", true) as A;
    const id = options.id(...callArgs);
    if (typeof id !== "string" || id.trim() === "") {
      throw new LocalProtectionError("INVALID_ID", "A stable nonempty logical action id is required. Reuse it for retries and choose a new one for a separate intentional action.");
    }
    const payload = copyData(options.payload(...callArgs)) as JsonObject;
    const fingerprint = fingerprintConnectPayload(payload);
    const contextualSession = localProtectionSessionContext.getStore();
    const sharedSession = ledgerMode === "create-if-missing" && contextualSession?.statePath === statePath
      ? contextualSession : undefined;
    let initialIdentity: StateFileIdentity | undefined;
    if (ledgerMode === "existing") {
      try {
        initialIdentity = stateFileIdentity(statePath);
      } catch (cause) {
        throw new LocalProtectionError("STATE_UNAVAILABLE", "The existing ledger is unavailable. Restore its original history.", { cause });
      }
    }
    const assertLedgerIdentity = () => {
      sharedSession?.assertStateIdentity();
      if (initialIdentity && !sameStateFile(initialIdentity, stateFileIdentity(statePath))) {
        throw new LocalProtectionError("STATE_UNAVAILABLE", "The original ledger changed during the operation.");
      }
    };
    const db = sharedSession
      ? await sharedSession.databaseForCall()
      : await openLocalDatabase(statePath, ledgerMode);
    const closeAfterCall = !sharedSession;

    try {
      const owner = randomUUID();
      let shouldDispatch = false;
      let managed = false;
      let row: Row;
      try {
        db.exec("BEGIN IMMEDIATE");
        assertLedgerIdentity();
        managed = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='local_ledger_policy'").get());
        if (managed && !requireApproval) {
          throw new LocalProtectionError("INTENT_REQUIRED", "This managed ledger requires the host-approved intent API.");
        }
        if (requireApproval) {
          const policy = db.prepare("SELECT witness_id FROM local_ledger_policy WHERE singleton=1").get() as
            { witness_id: string | null } | undefined;
          if (!policy || (!reconcileOnly && policy.witness_id !== (witnessId ?? null))) {
            throw new LocalProtectionError("STATE_UNAVAILABLE", "The managed ledger's witness policy differs from the configured authority.");
          }
          const approval = readApproval(db, id);
          if (!approval) throw new LocalProtectionError("INTENT_REQUIRED", "The host has not approved this intent.");
          if (approval.fingerprint !== fingerprint) {
            throw new LocalProtectionError("CONFLICT", "The supplied effect differs from the host-approved effect.");
          }
        }
        row = db.prepare("SELECT fingerprint,state,result_json,owner,lease_until FROM local_operations WHERE id=?").get(id) as Row;
        if (!row) {
          if (reconcileOnly) {
            throw new LocalProtectionError("OPERATION_NOT_RECORDED", "There is no recorded dispatch claim in this ledger. Verify continuity before taking any action.");
          }
          db.prepare("INSERT INTO local_operations(id,fingerprint,state,result_json,owner,lease_until) VALUES(?,?,'CLAIMED',NULL,?,?)")
            .run(id, fingerprint, owner, Date.now() + leaseMs);
          shouldDispatch = true;
        } else if (row.fingerprint === fingerprint && row.state === "CLAIMED" &&
                   (row.lease_until ?? 0) <= Date.now()) {
          db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=?").run(id);
          row = { ...row, state: "UNKNOWN", owner: null, lease_until: null };
        }
        db.exec("COMMIT");
      } catch (cause) {
        if (db.isTransaction) {
          try { db.exec("ROLLBACK"); } catch { sharedSession?.invalidate(); }
        }
        if (cause instanceof LocalProtectionError) throw cause;
        throw new LocalProtectionError("STATE_UNAVAILABLE", "Could not atomically claim durable Once state. The operation was not dispatched; retry with the same id after restoring state access.", { cause });
      }

      if (!shouldDispatch) {
        if (row!.fingerprint !== fingerprint) {
          throw new LocalProtectionError("CONFLICT", `Logical action ${id} has a different effect-bearing payload. Choose a new id only for a genuinely new action; no write was dispatched.`);
        }
        if (row!.state === "CONFIRMED") return decodeResult<T>(row!.result_json!);
        if (row!.state === "CLAIMED") {
          throw new LocalProtectionError("IN_FLIGHT", `Logical action ${id} is still in flight. Wait and retry with the same id; do not call the underlying operation directly.`);
        }
        if (!options.reconcile) {
          throw new LocalProtectionError("UNKNOWN", `RETRY BLOCKED — ORIGINAL OUTCOME UNKNOWN. Operation ${id} may already have succeeded. Repeating it could create another external effect; no second write was dispatched. Next action: supply an authoritative read-only reconcile callback or investigate provider truth; retain the same identity and durable state.`);
        }
        const noteLookup = (outcome: "UNKNOWN" | "NOT_FOUND" | "UNAVAILABLE" | "INVALID") => {
          if (!managed) return;
          assertLedgerIdentity();
          db.prepare(`UPDATE local_operation_history SET last_lookup=?,last_lookup_at=? WHERE id=?
            AND EXISTS (SELECT 1 FROM local_operations WHERE id=? AND state='UNKNOWN')`)
            .run(outcome, Date.now(), id, id);
        };
        let observation: LocalObservation<T>;
        try {
          observation = await options.reconcile({ id, payload: copyData(payload) as JsonObject });
        } catch (cause) {
          noteLookup("UNAVAILABLE");
          throw new LocalProtectionError("UNKNOWN", `Provider truth for ${id} is unavailable. No second write was dispatched.`, { cause });
        }
        if (observation?.state !== "CONFIRMED") {
          noteLookup(observation?.state === "ABSENT" ? "NOT_FOUND" : "UNKNOWN");
          throw new LocalProtectionError("UNKNOWN", `Provider truth for ${id} did not confirm an effect. Local mode will not redispatch after an ambiguous attempt; investigate or use a provider idempotency integration.`);
        }
        if (!Object.prototype.hasOwnProperty.call(observation, "result")) {
          noteLookup("INVALID");
          throw new LocalProtectionError("INVALID_TRUTH", "CONFIRMED provider truth must include a result; the outcome remains UNKNOWN and no second write was dispatched.");
        }
        let resultJson: string;
        try {
          resultJson = encodeResult(observation.result);
        } catch (cause) {
          noteLookup("INVALID");
          throw new LocalProtectionError("INVALID_TRUTH", "CONFIRMED provider truth needs a JSON-safe result. No second write was dispatched.", { cause });
        }
        assertLedgerIdentity();
        const confirmation = db.prepare("UPDATE local_operations SET state='CONFIRMED',result_json=? WHERE id=? AND state='UNKNOWN'").run(resultJson, id);
        if (confirmation.changes !== 1) {
          const latest = db.prepare("SELECT fingerprint,state,result_json,owner,lease_until FROM local_operations WHERE id=?").get(id) as Row | undefined;
          if (latest?.fingerprint === fingerprint && latest.state === "CONFIRMED" && latest.result_json !== null) {
            return decodeResult<T>(latest.result_json);
          }
          throw new LocalProtectionError("UNKNOWN", `State changed while reconciling ${id}. Retry with the same id; no second write was dispatched.`);
        }
        return decodeResult<T>(resultJson);
      }

      let currentFingerprint: string;
      try {
        if (options.id(...callArgs) !== id) {
          throw new Error("Logical action id changed.");
        }
        currentFingerprint = fingerprintConnectPayload(
          copyData(options.payload(...callArgs)) as JsonObject,
        );
      } catch (cause) {
        db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED' AND owner=?").run(id, owner);
        throw new LocalProtectionError("PAYLOAD_DRIFT", `Payload of ${id} changed before dispatch. No operation was dispatched.`, { cause });
      }
      if (currentFingerprint !== fingerprint) {
        db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED' AND owner=?").run(id, owner);
        throw new LocalProtectionError("PAYLOAD_DRIFT", `Payload of ${id} changed before dispatch. No operation was dispatched.`);
      }

      if (witness) {
        let reserved: boolean;
        try {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            reserved = await Promise.race([
              Promise.resolve().then(() => witness(id, fingerprint)),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error("Independent admission timed out.")), Math.min(leaseMs, 30_000));
              }),
            ]);
          } finally {
            clearTimeout(timeout);
          }
        } catch (cause) {
          db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED' AND owner=?").run(id, owner);
          throw new LocalProtectionError("UNKNOWN", "Independent admission could not be established. No write was dispatched by this attempt. Reconcile the original operation.", { cause });
        }
        if (reserved !== true) {
          db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED' AND owner=?").run(id, owner);
          throw new LocalProtectionError("UNKNOWN", "Independent admission refused a fresh dispatch. Reconcile the original operation.");
        }
        const claim = db.prepare("SELECT owner,state,lease_until FROM local_operations WHERE id=?").get(id) as
          Pick<Row, "owner" | "state" | "lease_until"> | undefined;
        if (claim?.owner !== owner || claim.state !== "CLAIMED" || (claim.lease_until ?? 0) <= Date.now()) {
          throw new LocalProtectionError("EXECUTION_RIGHT_LOST", "Local claim changed or expired during admission. No write was dispatched by this attempt.");
        }
      }

      if (sharedSession || initialIdentity) {
        try {
          assertLedgerIdentity();
        } catch (cause) {
          try {
            db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED' AND owner=?").run(id, owner);
          } catch { /* The session is already fail-closed. */ }
          throw cause;
        }
      }

      let result: T;
      try {
        result = await operation!.apply(this, callArgs);
      } catch (cause) {
        try {
          db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED' AND owner=?").run(id, owner);
        } catch { sharedSession?.invalidate(); }
        throw new LocalProtectionError("UNKNOWN", `ORIGINAL OUTCOME UNKNOWN. Operation ${id} threw after dispatch; its external outcome may be unknown. It may already have succeeded. Future unsafe redispatch is blocked. Next action: reconcile authoritative provider truth before retrying with the same identity and durable state.`, { cause });
      }
      let resultJson: string;
      try {
        resultJson = encodeResult(result);
      } catch (cause) {
        try {
          db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED' AND owner=?").run(id, owner);
        } catch { sharedSession?.invalidate(); }
        throw new LocalProtectionError("UNREPLAYABLE_RESULT", `Operation ${id} returned a non-JSON-safe result. Outcome is UNKNOWN; return a JSON-safe receipt and reconcile before retrying.`, { cause });
      }

      if (sharedSession || initialIdentity) {
        try {
          assertLedgerIdentity();
        } catch (cause) {
          try {
            db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED' AND owner=?").run(id, owner);
          } catch { /* The session is already fail-closed. */ }
          throw new LocalProtectionError("UNKNOWN", `Operation ${id} completed but its durable state path changed before confirmation. The external outcome may be unknown; do not retry until state is restored.`, { cause });
        }
      }

      const update = db.prepare("UPDATE local_operations SET state='CONFIRMED',result_json=?,owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED' AND owner=?")
        .run(resultJson, id, owner);
      if (update.changes !== 1) {
        throw new LocalProtectionError("EXECUTION_RIGHT_LOST", `Operation ${id} completed after its claim changed. Reconcile provider truth before retrying.`);
      }
      return decodeResult<T>(resultJson);
    } finally {
      if (closeAfterCall) db.close();
    }
  };
}

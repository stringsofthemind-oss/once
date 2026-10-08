import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { types } from "node:util";
import { canonicalizeConnectPayload, fingerprintConnectPayload } from "./connect/binding.js";

import type { ExecutionAuthority, ExecutionRow, ExecutionStore } from "./execution-store.js";

type JsonObject = Record<string, unknown>;

type LocalStatement = {
  get(...params: unknown[]): unknown;
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
  options?: Readonly<{ timeout?: number }>,
) => LocalDatabase;

type StateFileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}>;

const LOCAL_STATE_SCHEMA = "CREATE TABLE IF NOT EXISTS local_operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('CLAIMED','UNKNOWN','CONFIRMED')), result_json TEXT, owner TEXT, lease_until INTEGER);";

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
  /** Explicit shared authority. Mutually exclusive with statePath; no fallback. */
  authority?: ExecutionAuthority;
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

type Row = ExecutionRow;

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

async function openLocalDatabase(statePath: string): Promise<LocalDatabase> {
  const DatabaseSync = await loadDatabaseSync();
  let db: LocalDatabase | undefined;
  try {
    mkdirSync(path.dirname(statePath), { recursive: true });
    db = new DatabaseSync(statePath, { timeout: 30_000 });
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; ${LOCAL_STATE_SCHEMA}`);
    return db;
  } catch (cause) {
    if (db) {
      try { db.close(); } catch { /* Preserve the initialization error. */ }
    }
    throw new LocalProtectionError("STATE_UNAVAILABLE", `Cannot open durable Once state at ${statePath}. The operation was not dispatched. Restore access to this same file before retrying.`, { cause });
  }
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

/** SQLite implementation of the same storage seam used by shared authority. */
async function openLocalStore(statePath: string): Promise<ExecutionStore> {
  const contextual = localProtectionSessionContext.getStore();
  const shared = contextual?.statePath === statePath ? contextual : undefined;
  const session = shared ?? createLocalProtectionSession(statePath);
  const db = await session.databaseForCall();
  const read = (id: string) => db.prepare("SELECT fingerprint,state,result_json,owner,lease_until FROM local_operations WHERE id=?").get(id) as Row | undefined;
  const transaction = <T>(action: () => T): T => {
    session.assertStateIdentity();
    try {
      db.exec("BEGIN IMMEDIATE");
      const value = action();
      db.exec("COMMIT");
      return value;
    } catch (cause) {
      if (db.isTransaction) {
        try { db.exec("ROLLBACK"); } catch { session.invalidate(); }
      }
      if (cause instanceof LocalProtectionError) throw cause;
      throw new LocalProtectionError("STATE_UNAVAILABLE", "Durable execution state is unavailable; no fresh dispatch is authorized.", { cause });
    }
  };
  return {
    async reserve(id, fingerprint, owner, leaseMs) {
      return transaction(() => {
        let row = read(id);
        if (!row) {
          db.prepare("INSERT INTO local_operations(id,fingerprint,state,result_json,owner,lease_until) VALUES(?,?,'CLAIMED',NULL,?,?)")
            .run(id, fingerprint, owner, Date.now() + leaseMs);
          return { dispatch: true };
        }
        if (row.fingerprint === fingerprint && row.state === "CLAIMED" && row.lease_until! <= Date.now()) {
          db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED'").run(id);
          row = read(id)!;
        }
        return { dispatch: false, row };
      });
    },
    async assertDispatch(id, fingerprint, owner) {
      transaction(() => {
        const row = read(id);
        if (row?.fingerprint !== fingerprint || row.state !== "CLAIMED" || row.owner !== owner) {
          throw new LocalProtectionError("EXECUTION_RIGHT_LOST", "The execution claim is stale. No fresh dispatch is authorized.");
        }
      });
    },
    async markUnknown(id, fingerprint, owner) {
      transaction(() => db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND fingerprint=? AND state='CLAIMED' AND owner=?").run(id, fingerprint, owner));
    },
    async confirm(id, fingerprint, owner, result) {
      return transaction(() => db.prepare("UPDATE local_operations SET state='CONFIRMED',result_json=?,owner=NULL,lease_until=NULL WHERE id=? AND fingerprint=? AND state='CLAIMED' AND owner=?")
        .run(result, id, fingerprint, owner).changes === 1);
    },
    async reconcile(id, fingerprint, result) {
      return transaction(() => {
        db.prepare("UPDATE local_operations SET state='CONFIRMED',result_json=? WHERE id=? AND fingerprint=? AND state='UNKNOWN'").run(result, id, fingerprint);
        return read(id);
      });
    },
    close() { if (!shared) session.close(); },
  };
}

/**
 * Protect an existing async operation while keeping its call
 * shape and dynamic receiver. Ordinary data arguments are snapshotted and
 * frozen; opaque handles keep their identity. SQLite coordinates processes
 * sharing the same durable local file. An explicit authority replaces only the
 * storage seam; execution and reconciliation decisions remain in this kernel.
 * Uncertain outcomes remain blocked; this wrapper never redispatches after
 * an ambiguous attempt, even if a lookup reports ABSENT.
 */
export function protectLocal<A extends unknown[], T>(
  operation: (...args: A) => Promise<T>,
  options: LocalProtectionOptions<A, T>,
): (...args: A) => Promise<T> {
  if (typeof operation !== "function" || typeof options?.id !== "function" || typeof options.payload !== "function") {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "protectLocal requires an async operation plus id and payload functions. The id must survive retries; payload must include every effect-bearing input.");
  }
  if (options.authority !== undefined && (options.statePath !== undefined || typeof options.authority?.open !== "function")) {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "Supply one explicit execution authority or a local statePath, never both.");
  }
  const authority = options.authority;
  const statePath = resolvedStatePath(options.statePath);
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
    const store = authority
      ? await authority.open()
      : await openLocalStore(statePath);
    try {
      const owner = randomUUID();
      const { dispatch: shouldDispatch, row } = await store.reserve(id, fingerprint, owner, leaseMs);
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
        let observation: LocalObservation<T>;
        try {
          observation = await options.reconcile({ id, payload: copyData(payload) as JsonObject });
        } catch (cause) {
          throw new LocalProtectionError("UNKNOWN", `Provider truth for ${id} is unavailable. No second write was dispatched.`, { cause });
        }
        if (observation?.state !== "CONFIRMED") {
          throw new LocalProtectionError("UNKNOWN", `Provider truth for ${id} did not confirm an effect. Local mode will not redispatch after an ambiguous attempt; investigate or use a provider idempotency integration.`);
        }
        if (!Object.prototype.hasOwnProperty.call(observation, "result")) {
          throw new LocalProtectionError("INVALID_TRUTH", "CONFIRMED provider truth must include a result; the outcome remains UNKNOWN and no second write was dispatched.");
        }
        let resultJson: string;
        try {
          resultJson = encodeResult(observation.result);
        } catch (cause) {
          throw new LocalProtectionError("INVALID_TRUTH", "CONFIRMED provider truth needs a JSON-safe result. No second write was dispatched.", { cause });
        }
        const latest = await store.reconcile(id, fingerprint, resultJson);
        if (latest?.fingerprint === fingerprint && latest.state === "CONFIRMED" && latest.result_json !== null) {
          return decodeResult<T>(latest.result_json);
        }
        throw new LocalProtectionError("UNKNOWN", `State changed while reconciling ${id}. Retry with the same id; no second write was dispatched.`);
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
        await store.markUnknown(id, fingerprint, owner);
        throw new LocalProtectionError("PAYLOAD_DRIFT", `Payload of ${id} changed before dispatch. No operation was dispatched.`, { cause });
      }
      if (currentFingerprint !== fingerprint) {
        await store.markUnknown(id, fingerprint, owner);
        throw new LocalProtectionError("PAYLOAD_DRIFT", `Payload of ${id} changed before dispatch. No operation was dispatched.`);
      }

      await store.assertDispatch(id, fingerprint, owner);

      // Shared admission crosses an asynchronous boundary. Recheck selectors
      // synchronously afterward so that admission-time drift cannot be executed.
      try {
        if (options.id(...callArgs) !== id ||
            fingerprintConnectPayload(copyData(options.payload(...callArgs)) as JsonObject) !== fingerprint) {
          throw new Error("Binding changed during authority admission.");
        }
      } catch (cause) {
        await store.markUnknown(id, fingerprint, owner);
        throw new LocalProtectionError("PAYLOAD_DRIFT", `Binding of ${id} changed during authority admission. No operation was dispatched.`, { cause });
      }

      let result: T;
      try {
        result = await operation.apply(this, callArgs);
      } catch (cause) {
        try {
          await store.markUnknown(id, fingerprint, owner);
        } catch { /* Durable claim remains non-dispatchable. */ }
        throw new LocalProtectionError("UNKNOWN", `ORIGINAL OUTCOME UNKNOWN. Operation ${id} threw after dispatch; its external outcome may be unknown. It may already have succeeded. Future unsafe redispatch is blocked. Next action: reconcile authoritative provider truth before retrying with the same identity and durable state.`, { cause });
      }
      let resultJson: string;
      try {
        resultJson = encodeResult(result);
      } catch (cause) {
        try {
          await store.markUnknown(id, fingerprint, owner);
        } catch { /* Durable claim remains non-dispatchable. */ }
        throw new LocalProtectionError("UNREPLAYABLE_RESULT", `Operation ${id} returned a non-JSON-safe result. Outcome is UNKNOWN; return a JSON-safe receipt and reconcile before retrying.`, { cause });
      }

      let confirmed: boolean;
      try {
        confirmed = await store.confirm(id, fingerprint, owner, resultJson);
      } catch (cause) {
        throw new LocalProtectionError("UNKNOWN", `Operation ${id} completed but durable confirmation failed. Restore authority and reconcile provider truth; never redispatch.`, { cause });
      }
      if (!confirmed) {
        throw new LocalProtectionError("EXECUTION_RIGHT_LOST", `Operation ${id} completed after its claim changed. Reconcile provider truth before retrying.`);
      }
      return decodeResult<T>(resultJson);
    } finally {
      store.close();
    }
  };
}

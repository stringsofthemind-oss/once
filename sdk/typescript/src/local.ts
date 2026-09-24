import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { types } from "node:util";
import { canonicalizeConnectPayload, fingerprintConnectPayload } from "./connect/binding.js";

type JsonObject = Record<string, unknown>;

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
  if (typeof operation !== "function" || typeof options?.id !== "function" || typeof options.payload !== "function") {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "protectLocal requires an async operation plus id and payload functions. The id must survive retries; payload must include every effect-bearing input.");
  }
  const statePath = path.resolve(options.statePath ?? path.join(process.cwd(), ".once", "operations.sqlite"));
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
    if (Number(process.versions.node.split(".")[0]) < 24 ||
        (Number(process.versions.node.split(".")[0]) === 24 && Number(process.versions.node.split(".")[1]) < 15)) {
      throw new LocalProtectionError("UNSUPPORTED_RUNTIME", "Local SQLite protection requires Node.js 24.15 or later. Use a supported Node runtime or the hosted Once execution path.");
    }
    let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch (cause) {
      throw new LocalProtectionError("SQLITE_UNAVAILABLE", "Node SQLite is unavailable. Enable node:sqlite or use the hosted Once execution path; the operation was not dispatched.", { cause });
    }
    let db!: InstanceType<typeof DatabaseSync>;
    try {
      mkdirSync(path.dirname(statePath), { recursive: true });
      db = new DatabaseSync(statePath, { timeout: 30_000 });
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS local_operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('CLAIMED','UNKNOWN','CONFIRMED')), result_json TEXT, owner TEXT, lease_until INTEGER);");
    } catch (cause) {
      if (db) {
        try { db.close(); } catch { /* Preserve the initialization error. */ }
      }
      throw new LocalProtectionError("STATE_UNAVAILABLE", `Cannot open durable Once state at ${statePath}. The operation was not dispatched. Restore access to this same file before retrying.`, { cause });
    }

    const owner = randomUUID();
    let shouldDispatch = false;
    let row: Row;
    try {
      db.exec("BEGIN IMMEDIATE");
      row = db.prepare("SELECT fingerprint,state,result_json,owner,lease_until FROM local_operations WHERE id=?").get(id) as Row;
      if (!row) {
        db.prepare("INSERT INTO local_operations(id,fingerprint,state,result_json,owner,lease_until) VALUES(?,?,'CLAIMED',NULL,?,?)")
          .run(id, fingerprint, owner, Date.now() + leaseMs);
        shouldDispatch = true;
      }
      db.exec("COMMIT");
    } catch (cause) {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
      throw new LocalProtectionError("STATE_UNAVAILABLE", "Could not atomically claim durable Once state. The operation was not dispatched; retry with the same id after restoring state access.", { cause });
    }

    try {
      if (!shouldDispatch) {
        if (row!.fingerprint !== fingerprint) {
          throw new LocalProtectionError("CONFLICT", `Logical action ${id} has a different effect-bearing payload. Choose a new id only for a genuinely new action; no write was dispatched.`);
        }
        if (row!.state === "CONFIRMED") return decodeResult<T>(row!.result_json!);
        if (row!.state === "CLAIMED" && row!.lease_until! > Date.now()) {
          throw new LocalProtectionError("IN_FLIGHT", `Logical action ${id} is still in flight. Wait and retry with the same id; do not call the underlying operation directly.`);
        }
        // Persist uncertainty before any fallible external lookup.
        db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED'").run(id);
        if (!options.reconcile) {
          throw new LocalProtectionError("UNKNOWN", `Outcome of ${id} is unknown. Supply an authoritative reconcile callback or investigate provider truth; no second write was dispatched.`);
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

      // Recheck handles whose state the selectors might have read while the
      // claim was being established. A changed claim stays uncertain.
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
      let result: T;
      try {
        result = await operation.apply(this, callArgs);
      } catch (cause) {
        db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED' AND owner=?").run(id, owner);
        throw new LocalProtectionError("UNKNOWN", `Operation ${id} threw after dispatch; its external outcome may be unknown. Reconcile provider truth before retrying.`, { cause });
      }
      let resultJson: string;
      try {
        resultJson = encodeResult(result);
      } catch (cause) {
        db.prepare("UPDATE local_operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED' AND owner=?").run(id, owner);
        throw new LocalProtectionError("UNREPLAYABLE_RESULT", `Operation ${id} returned a non-JSON-safe result. Outcome is UNKNOWN; return a JSON-safe receipt and reconcile before retrying.`, { cause });
      }
      const update = db.prepare("UPDATE local_operations SET state='CONFIRMED',result_json=?,owner=NULL,lease_until=NULL WHERE id=? AND state='CLAIMED' AND owner=?")
        .run(resultJson, id, owner);
      if (update.changes !== 1) {
        throw new LocalProtectionError("EXECUTION_RIGHT_LOST", `Operation ${id} completed after its claim changed. Reconcile provider truth before retrying.`);
      }
      return decodeResult<T>(resultJson);
    } finally {
      db.close();
    }
  };
}

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { canonicalizeConnectPayload, fingerprintConnectPayload } from "./connect/binding.js";

type JsonObject = Record<string, unknown>;

export type LocalObservation<T> =
  | { state: "CONFIRMED"; result: T }
  | { state: "ABSENT" | "UNKNOWN" };

export interface LocalProtectionOptions<A extends unknown[], T> {
  /** Stable identity of one intended external effect, shared by every retry. */
  id: (...args: A) => string;
  /** The complete effect-bearing payload. Exclude transport-only values. */
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

function encodeResult(value: unknown): string {
  // The existing canonicalizer rejects cycles, undefined nested values,
  // nonfinite numbers, exotic objects, and prototype-bearing class instances.
  canonicalizeConnectPayload({ value: value === undefined ? null : value });
  return JSON.stringify({ hasValue: value !== undefined, value });
}

function decodeResult<T>(encoded: string): T {
  const envelope = JSON.parse(encoded) as { hasValue: boolean; value?: T };
  return (envelope.hasValue ? envelope.value : undefined) as T;
}

/**
 * Protect an existing async operation on one machine without changing its
 * arguments. SQLite is durable and coordinates processes sharing this file.
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

  return async (...args: A): Promise<T> => {
    const id = options.id(...args);
    if (typeof id !== "string" || id.trim() === "") {
      throw new LocalProtectionError("INVALID_ID", "A stable nonempty logical action id is required. Reuse it for retries and choose a new one for a separate intentional action.");
    }
    const payload = options.payload(...args);
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
    let db: InstanceType<typeof DatabaseSync>;
    try {
      mkdirSync(path.dirname(statePath), { recursive: true });
      db = new DatabaseSync(statePath, { timeout: 30_000 });
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS local_operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('CLAIMED','UNKNOWN','CONFIRMED')), result_json TEXT, owner TEXT, lease_until INTEGER);");
    } catch (cause) {
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
          observation = await options.reconcile({ id, payload });
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

      let result: T;
      try {
        result = await operation(...args);
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
      return result;
    } finally {
      db.close();
    }
  };
}

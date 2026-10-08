import { LocalProtectionError } from "./local.js";
import type { ExecutionAuthority, ExecutionRow, ExecutionStore } from "./execution-store.js";

/** Compatible with a host-owned node-postgres Pool; credentials never enter Once. */
export interface AuthoritySqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(destroy?: boolean): void;
}
export interface AuthoritySqlPool { connect(): Promise<AuthoritySqlClient> }

export interface AuthorityCheckpoint {
  readonly authorityId: string;
  readonly generation: string;
  readonly epoch: string;
  readonly revision: string;
}

export interface ContinuityWitness {
  /**
   * Linearizable, durable CAS in a separate failure/restore domain. Return true
   * only after persisting next, false on mismatch (including missing state).
   * Never create missing state, accept stale reads, or retry an ambiguous CAS.
   * Host must provision and authenticate this authority out of band.
   */
  compareAndAdvance(expected: AuthorityCheckpoint, next: AuthorityCheckpoint): Promise<boolean>;
}

export interface PostgresAuthorityOptions {
  pool: AuthoritySqlPool;
  witness: ContinuityWitness;
  /** Fixed trusted host namespace, shared by every worker for the same domain. */
  authorityId: string;
  expectedGeneration: string;
  expectedEpoch: string;
}

const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const fail = (code: string, message: string): never => { throw new LocalProtectionError(code, message); };

/**
 * Draft shared storage adapter for the EXISTING protectLocal execution kernel.
 * No DDL, bootstrap, takeover, dispatch, provider lookup, or local fallback.
 * Each short SQL transaction locks the authority row and advances the external
 * witness BEFORE committing. A failed/ambiguous commit sacrifices availability:
 * the witness stays ahead and all subsequent access fails closed.
 */
export function createPostgresExecutionAuthority(options: PostgresAuthorityOptions): ExecutionAuthority {
  if (!options || typeof options.pool?.connect !== "function" ||
      typeof options.witness?.compareAndAdvance !== "function" ||
      typeof options.authorityId !== "string" || !options.authorityId.trim() ||
      typeof options.expectedGeneration !== "string" || !options.expectedGeneration.trim() ||
      !decimal(options.expectedEpoch)) {
    return fail("INVALID_CONFIGURATION", "Shared authority requires a fixed pool, external continuity witness, authority identity, generation and decimal epoch.");
  }
  const { pool, witness, authorityId, expectedGeneration, expectedEpoch } = options;
  const compareAndAdvance = witness.compareAndAdvance.bind(witness);
  const connect = pool.connect.bind(pool);

  async function transaction<T>(action: (client: AuthoritySqlClient, now: number) => Promise<T>): Promise<T> {
    let client: AuthoritySqlClient | undefined;
    let committed = false;
    try {
      client = await connect();
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      // Require durable acknowledgement even if the host's session default differs.
      await client.query("SET LOCAL synchronous_commit = on");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const { rows } = await client.query(
        "SELECT schema_version,generation,epoch::text,revision::text FROM once_execution.authorities WHERE authority_id=$1 FOR UPDATE", [authorityId]);
      const meta = rows[0];
      if (!meta) fail("AUTHORITY_MISSING", "Expected execution authority is missing. Restore the original authority; it will not be recreated.");
      if (meta.schema_version !== 1 || meta.generation !== expectedGeneration || meta.epoch !== expectedEpoch || !decimal(meta.revision)) {
        fail("STALE_AUTHORITY", "Execution authority schema, generation or epoch does not match host admission.");
      }
      // Evaluate leases using database time after acquiring the lock, never worker time.
      const clock = await client.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now");
      const now = Number(clock.rows[0]?.now);
      if (!Number.isSafeInteger(now)) fail("STATE_UNAVAILABLE", "Authority clock is invalid.");
      if (BigInt(meta.revision) >= 9223372036854775807n) fail("STATE_UNAVAILABLE", "Authority revision is exhausted; operator review is required.");
      const result = await action(client, now);
      const expected = Object.freeze({ authorityId, generation: expectedGeneration, epoch: expectedEpoch, revision: meta.revision as string });
      const next = Object.freeze({ ...expected, revision: (BigInt(meta.revision) + 1n).toString() });
      let accepted: boolean;
      try { accepted = await compareAndAdvance(expected, next); }
      catch { return fail("CONTINUITY_UNAVAILABLE", "Continuity acknowledgement is unavailable or ambiguous. No new dispatch is authorized; operator recovery is required."); }
      if (accepted !== true) fail("CONTINUITY_LOST", "Execution history does not match the independent continuity authority. No fresh dispatch is authorized.");
      await client.query("UPDATE once_execution.authorities SET revision=$2::bigint WHERE authority_id=$1", [authorityId, next.revision]);
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (client) { try { await client.query("ROLLBACK"); } catch { /* Destroy below. */ } }
      if (error instanceof LocalProtectionError) throw error;
      // Driver errors may contain DSNs, passwords or query values. Do not attach them.
      return fail("STATE_UNAVAILABLE", "Shared authority access or commit failed. No fresh dispatch is authorized; verify continuity before recovery.");
    } finally {
      try { client?.release(!committed); }
      catch { fail("STATE_UNAVAILABLE", "Shared authority connection cleanup failed; no fresh dispatch is authorized."); }
    }
  }

  async function read(client: AuthoritySqlClient, id: string): Promise<ExecutionRow | undefined> {
    const result = await client.query("SELECT fingerprint,state,result_json,owner,lease_until::text FROM once_execution.operations WHERE authority_id=$1 AND id=$2", [authorityId, id]);
    const row = result.rows[0];
    if (!row) return undefined;
    const lease = row.lease_until === null ? null : Number(row.lease_until);
    if (typeof row.fingerprint !== "string" || !["CLAIMED", "UNKNOWN", "CONFIRMED"].includes(row.state) ||
        (row.state === "CLAIMED" && (typeof row.owner !== "string" || !row.owner || !Number.isSafeInteger(lease))) ||
        (row.state !== "CLAIMED" && (row.owner !== null || lease !== null)) ||
        (row.state === "CONFIRMED" ? typeof row.result_json !== "string" : row.result_json !== null)) {
      fail("STATE_UNAVAILABLE", "Shared execution record is malformed; no dispatch is authorized.");
    }
    return { ...row, lease_until: lease };
  }

  const store: ExecutionStore = {
    async reserve(id, fingerprint, owner, leaseMs) {
      return transaction(async (client, now) => {
        const row = await read(client, id);
        if (row) {
          if (row.fingerprint === fingerprint && row.state === "CLAIMED" && row.lease_until! <= now) {
            await client.query("UPDATE once_execution.operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE authority_id=$1 AND id=$2", [authorityId, id]);
            return { dispatch: false, row: { ...row, state: "UNKNOWN", owner: null, lease_until: null } as ExecutionRow };
          }
          return { dispatch: false, row };
        }
        if (!Number.isSafeInteger(now + leaseMs)) fail("INVALID_LEASE", "Lease exceeds the safe authority clock range.");
        await client.query("INSERT INTO once_execution.operations(authority_id,id,fingerprint,state,owner,lease_until) VALUES($1,$2,$3,'CLAIMED',$4,$5)", [authorityId, id, fingerprint, owner, now + leaseMs]);
        return { dispatch: true };
      });
    },
    async assertDispatch(id, fingerprint, owner) {
      await transaction(async (client, now) => {
        const row = await read(client, id);
        if (row?.fingerprint !== fingerprint || row.state !== "CLAIMED" || row.owner !== owner || row.lease_until! <= now) {
          fail("EXECUTION_RIGHT_LOST", "Execution fence is stale or expired. No fresh dispatch is authorized.");
        }
      });
    },
    async markUnknown(id, fingerprint, owner) {
      await transaction(async client => {
        await client.query("UPDATE once_execution.operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE authority_id=$1 AND id=$2 AND fingerprint=$3 AND state='CLAIMED' AND owner=$4", [authorityId, id, fingerprint, owner]);
      });
    },
    async confirm(id, fingerprint, owner, result) {
      return transaction(async (client, now) => {
        const update = await client.query("UPDATE once_execution.operations SET state='CONFIRMED',result_json=$5,owner=NULL,lease_until=NULL WHERE authority_id=$1 AND id=$2 AND fingerprint=$3 AND state='CLAIMED' AND owner=$4 AND lease_until>$6", [authorityId, id, fingerprint, owner, result, now]);
        return update.rowCount === 1;
      });
    },
    async reconcile(id, fingerprint, result) {
      return transaction(async client => {
        await client.query("UPDATE once_execution.operations SET state='CONFIRMED',result_json=$4 WHERE authority_id=$1 AND id=$2 AND fingerprint=$3 AND state='UNKNOWN'", [authorityId, id, fingerprint, result]);
        return read(client, id);
      });
    },
    close() { /* Pool lifecycle is host-owned; no request shuts down other workers. */ },
  };
  Object.freeze(store);
  return Object.freeze({ async open() { return store; } });
}

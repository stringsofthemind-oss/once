import { LocalProtectionError, snapshotLocalData } from "./local.js";
import type { ExecutionAuthority, ExecutionRow, ExecutionStore } from "./execution-store.js";
import { witnessUsesPool } from "./postgres-continuity-witness.js";
import { createHash, randomUUID } from "node:crypto";
import { HOST_INTENT_AUTHORITY_CONTRACT, hostIntentEffectFingerprint, type HostIntentAuthority, type HostIntentBinding, type HostIntentRequest } from "./host-intent.js";

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
  /** Required by the host-intent v2 protocol; absent in revision-only v1. */
  readonly stateDigest?: string;
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
  /** Bounded acknowledgement deadline; ambiguity blocks, never retries CAS. */
  witnessTimeoutMs?: number;
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
  // Retained PR303 revision-only v1 contract. It does NOT qualify for the
  // state-bound host-intent profile; its current-metadata partial restore limit
  // is retained as a RED control. No implicit upgrade is performed.
  return buildPostgresAuthority(options);
}

/** Runtime lookup authority: expose only this capability to the execution host.
 * Its SQL role needs SELECT on host_intents, never INSERT/UPDATE/DELETE.
 */
export function createPostgresIntentAuthority(options: PostgresAuthorityOptions): HostIntentAuthority {
  const authority = buildPostgresAuthority(options, true);
  return Object.freeze({ contract: HOST_INTENT_AUTHORITY_CONTRACT, open: authority.open, resolveIntent: authority.resolveIntent });
}

/** Explicit trusted host admission. Use a separately privileged admission pool.
 * Never expose this function/credential or trusted keys through model/tool input.
 * Existing key + changed effect is CONFLICT; no hash-based intent inference.
 */
export async function admitPostgresIntent(options: PostgresAuthorityOptions, request: HostIntentRequest): Promise<HostIntentBinding> {
  return buildPostgresAuthority(options, true).admitIntent(request);
}

function buildPostgresAuthority(options: PostgresAuthorityOptions, bindState = false) {
  if (!options || typeof options.pool?.connect !== "function" ||
      typeof options.witness?.compareAndAdvance !== "function" ||
      typeof options.authorityId !== "string" || !options.authorityId.trim() ||
      typeof options.expectedGeneration !== "string" || !options.expectedGeneration.trim() ||
      !decimal(options.expectedEpoch)) {
    return fail("INVALID_CONFIGURATION", "Shared authority requires a fixed pool, external continuity witness, authority identity, generation and decimal epoch.");
  }
  const { pool, witness, authorityId, expectedGeneration, expectedEpoch } = options;
  if (witnessUsesPool(witness, pool)) fail("INVALID_CONFIGURATION", "Execution and continuity authorities must not share a pool or restore domain.");
  const witnessTimeoutMs = options.witnessTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(witnessTimeoutMs) || witnessTimeoutMs <= 0 || witnessTimeoutMs > 60000) {
    fail("INVALID_CONFIGURATION", "Witness acknowledgement deadline must be between 1 and 60000 milliseconds.");
  }
  const compareAndAdvance = witness.compareAndAdvance.bind(witness);
  const connect = pool.connect.bind(pool);
  const stateDigest = async (client: AuthoritySqlClient): Promise<string> => {
    // Full namespace verification is deliberate. A current revision copied onto
    // empty/partial history must not pass. Normal writers hold the metadata lock.
    const operations = await client.query("SELECT id,fingerprint,state,result_json,owner,lease_until::text FROM once_execution.operations WHERE authority_id=$1 ORDER BY id COLLATE \"C\"", [authorityId]);
    const intents = await client.query("SELECT scope,intent_key,operation_id,effect_fingerprint FROM once_execution.host_intents WHERE authority_id=$1 ORDER BY scope COLLATE \"C\",intent_key COLLATE \"C\"", [authorityId]);
    const value = { contract: "once-authority-state-v2", operations: operations.rows.map(r => [r.id,r.fingerprint,r.state,r.result_json,r.owner,r.lease_until]),
      intents: intents.rows.map(r => [r.scope,r.intent_key,r.operation_id,r.effect_fingerprint]) };
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  };

  async function transaction<T>(action: (client: AuthoritySqlClient, now: number) => Promise<T>, beforeCommit?: (now: number) => void): Promise<T> {
    let client: AuthoritySqlClient | undefined;
    let committed = false;
    try {
      client = await connect();
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      // Require durable acknowledgement even if the host's session default differs.
      await client.query("SET LOCAL synchronous_commit = on");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const durability = await client.query("SELECT current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes");
      if (durability.rows[0]?.fsync !== "on" || durability.rows[0]?.full_page_writes !== "on") fail("STATE_UNAVAILABLE", "Execution authority requires durable PostgreSQL writes.");
      const { rows } = await client.query(
        `SELECT schema_version,generation,epoch::text,revision::text${bindState ? ",state_digest" : ""} FROM once_execution.authorities WHERE authority_id=$1 FOR UPDATE`, [authorityId]);
      const meta = rows[0];
      if (!meta) fail("AUTHORITY_MISSING", "Expected execution authority is missing. Restore the original authority; it will not be recreated.");
      if (meta.schema_version !== (bindState ? 2 : 1) || meta.generation !== expectedGeneration || meta.epoch !== expectedEpoch || !decimal(meta.revision)) {
        fail("STALE_AUTHORITY", "Execution authority schema, generation or epoch does not match host admission.");
      }
      // Evaluate leases using database time after acquiring the lock, never worker time.
      const clock = await client.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now");
      const now = Number(clock.rows[0]?.now);
      if (!Number.isSafeInteger(now)) fail("STATE_UNAVAILABLE", "Authority clock is invalid.");
      if (BigInt(meta.revision) >= 9223372036854775807n) fail("STATE_UNAVAILABLE", "Authority revision is exhausted; operator review is required.");
      if (bindState && (typeof meta.state_digest !== "string" || !/^[a-f0-9]{64}$/.test(meta.state_digest) || await stateDigest(client) !== meta.state_digest)) {
        fail("CONTINUITY_LOST", "Execution contents do not match their independently committed state. No dispatch is authorized.");
      }
      const result = await action(client, now);
      const expected = Object.freeze({ authorityId, generation: expectedGeneration, epoch: expectedEpoch, revision: meta.revision as string,
        ...(bindState ? { stateDigest: meta.state_digest as string } : {}) });
      const next = Object.freeze({ ...expected, revision: (BigInt(meta.revision) + 1n).toString(),
        ...(bindState ? { stateDigest: await stateDigest(client) } : {}) });
      let accepted: boolean;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        accepted = await Promise.race([
          compareAndAdvance(expected, next),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Witness deadline")), witnessTimeoutMs); }),
        ]);
      }
      catch { return fail("CONTINUITY_UNAVAILABLE", "Continuity acknowledgement is unavailable or ambiguous. No new dispatch is authorized; operator recovery is required."); }
      finally { if (deadline) clearTimeout(deadline); }
      if (accepted !== true) fail("CONTINUITY_LOST", "Execution history does not match the independent continuity authority. No fresh dispatch is authorized.");
      if (beforeCommit) {
        const currentClock = await client.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now");
        const currentNow = Number(currentClock.rows[0]?.now);
        if (!Number.isSafeInteger(currentNow)) fail("STATE_UNAVAILABLE", "Authority clock is invalid.");
        beforeCommit(currentNow);
      }
      if (bindState) await client.query("UPDATE once_execution.authorities SET revision=$2::bigint,state_digest=$3 WHERE authority_id=$1", [authorityId, next.revision, next.stateDigest]);
      else await client.query("UPDATE once_execution.authorities SET revision=$2::bigint WHERE authority_id=$1", [authorityId, next.revision]);
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
      let leaseUntil = 0, remainingMs = 0, checkedAt = 0;
      await transaction(async (client, now) => {
        const row = await read(client, id);
        if (row?.fingerprint !== fingerprint || row.state !== "CLAIMED" || row.owner !== owner || row.lease_until! <= now) {
          fail("EXECUTION_RIGHT_LOST", "Execution fence is stale or expired. No fresh dispatch is authorized.");
        }
        leaseUntil = row!.lease_until!;
        remainingMs = leaseUntil - now;
        checkedAt = performance.now();
      }, now => {
        if (leaseUntil <= now) fail("EXECUTION_RIGHT_LOST", "Execution lease expired during witness admission. No dispatch is authorized.");
      });
      if (performance.now() - checkedAt >= remainingMs) {
        fail("EXECUTION_RIGHT_LOST", "Execution lease expired before admission returned. No dispatch is authorized.");
      }
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
  const key = (scope: string, intentKey: string) => {
    if (typeof scope !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(scope) ||
        typeof intentKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(intentKey)) {
      fail("INTENT_REQUIRED", "Trusted host scope and durable intent key are required.");
    }
  };
  const readIntent = async (client: AuthoritySqlClient, scope: string, intentKey: string): Promise<HostIntentBinding | undefined> => {
    const { rows } = await client.query("SELECT operation_id,effect_fingerprint FROM once_execution.host_intents WHERE authority_id=$1 AND scope=$2 AND intent_key=$3", [authorityId, scope, intentKey]);
    if (!rows[0]) return undefined;
    const { operation_id: operationId, effect_fingerprint: effectFingerprint } = rows[0];
    if (typeof operationId !== "string" || !/^intent:[a-f0-9-]{36}$/.test(operationId) ||
        typeof effectFingerprint !== "string" || !/^once-connect-payload-v1:[a-f0-9]{64}$/.test(effectFingerprint)) fail("STATE_UNAVAILABLE", "Trusted intent record is malformed.");
    return Object.freeze({ scope, intentKey, operationId, effectFingerprint });
  };
  return Object.freeze({
    async open() { return store; },
    async resolveIntent(scope: string, intentKey: string) {
      key(scope, intentKey);
      return transaction(async client => {
        const binding = await readIntent(client, scope, intentKey);
        if (!binding) return fail("INTENT_REQUIRED", "Trusted intent is missing. Runtime recovery cannot create or replace it.");
        return binding;
      });
    },
    async admitIntent(request: HostIntentRequest) {
      request = snapshotLocalData(request);
      if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).sort().join(",") !== "effect,intentKey,scope") fail("INTENT_REQUIRED", "Explicit host scope, intent key and complete effect are required.");
      key(request.scope, request.intentKey);
      const fingerprint = hostIntentEffectFingerprint(request.effect);
      const { scope, intentKey } = request;
      return transaction(async client => {
        const existing = await readIntent(client, scope, intentKey);
        if (existing) {
          if (existing.effectFingerprint !== fingerprint) return fail("CONFLICT", "Trusted intent already binds a different complete effect.");
          return existing;
        }
        const binding = Object.freeze({ scope, intentKey, operationId: `intent:${randomUUID()}`, effectFingerprint: fingerprint });
        await client.query("INSERT INTO once_execution.host_intents(authority_id,scope,intent_key,operation_id,effect_fingerprint) VALUES($1,$2,$3,$4,$5)", [authorityId, scope, intentKey, binding.operationId, fingerprint]);
        return binding;
      });
    },
  });
}

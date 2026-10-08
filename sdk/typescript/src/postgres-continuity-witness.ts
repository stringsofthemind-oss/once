import { LocalProtectionError, snapshotLocalData } from "./local.js";
import type { AuthorityCheckpoint, AuthoritySqlClient, AuthoritySqlPool, ContinuityWitness } from "./postgres-authority.js";

const witnessPools = new WeakMap<ContinuityWitness, AuthoritySqlPool>();
export function witnessUsesPool(witness: ContinuityWitness, pool: AuthoritySqlPool): boolean {
  return witnessPools.get(witness) === pool;
}

export interface PostgresContinuityWitnessOptions {
  /** A separately authenticated, verified-TLS host pool in another restore domain. */
  pool: AuthoritySqlPool;
  /** Trusted operator-pinned witness identity, provisioned out of band. */
  expectedWitnessId: string;
}

const deny = (code: string): never => { throw new LocalProtectionError(code, "Independent continuity authority rejected the request; no execution permission is granted."); };
function checkpoint(value: AuthorityCheckpoint): AuthorityCheckpoint {
  let data: AuthorityCheckpoint;
  try { data = snapshotLocalData(value); } catch { return deny("INVALID_WITNESS_REQUEST"); }
  if (!data || Object.keys(data).sort().join(",") !== "authorityId,epoch,generation,revision" ||
      typeof data.authorityId !== "string" || !data.authorityId.trim() ||
      typeof data.generation !== "string" || !data.generation.trim() ||
      ![data.epoch, data.revision].every(x => typeof x === "string" && /^(0|[1-9][0-9]*)$/.test(x)) ||
      BigInt(data.epoch) > 9223372036854775807n || BigInt(data.revision) > 9223372036854775807n) {
    deny("INVALID_WITNESS_REQUEST");
  }
  return data;
}

/**
 * Durable witness implementation, never an execution dispatcher. Transport
 * authentication, TLS verification, connection deadlines, independent placement
 * and restore policy belong to the host-owned pool. No credentials/URLs/DDL,
 * retries, implicit provisioning, rewind or repair are accepted by this API.
 */
export function createPostgresContinuityWitness(options: PostgresContinuityWitnessOptions): ContinuityWitness {
  if (typeof options?.pool?.connect !== "function" || typeof options.expectedWitnessId !== "string" || !options.expectedWitnessId.trim()) {
    return deny("INVALID_CONFIGURATION");
  }
  const connect = options.pool.connect.bind(options.pool);
  const expectedWitnessId = options.expectedWitnessId;
  const witness: ContinuityWitness = Object.freeze({
    async compareAndAdvance(expectedInput: AuthorityCheckpoint, nextInput: AuthorityCheckpoint): Promise<boolean> {
      const expected = checkpoint(expectedInput), next = checkpoint(nextInput);
      if (next.authorityId !== expected.authorityId || next.generation !== expected.generation ||
          next.epoch !== expected.epoch || BigInt(next.revision) !== BigInt(expected.revision) + 1n) {
        return deny("INVALID_WITNESS_REQUEST");
      }
      let client: AuthoritySqlClient | undefined, committed = false;
      try {
        client = await connect();
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL synchronous_commit = on");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '10s'");
        const durability = await client.query("SELECT current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes");
        if (durability.rows[0]?.fsync !== "on" || durability.rows[0]?.full_page_writes !== "on") deny("WITNESS_DURABILITY_REQUIRED");
        const metadata = await client.query("SELECT witness_id,schema_version FROM once_continuity.metadata WHERE singleton=true FOR SHARE");
        if (!metadata.rows[0]) deny("WITNESS_MISSING");
        if (metadata.rows[0].witness_id !== expectedWitnessId || metadata.rows[0].schema_version !== 1) deny("STALE_WITNESS");
        const updated = await client.query(
          "UPDATE once_continuity.checkpoints SET revision=$5::bigint WHERE authority_id=$1 AND generation=$2 AND epoch=$3::bigint AND revision=$4::bigint RETURNING revision::text",
          [expected.authorityId, expected.generation, expected.epoch, expected.revision, next.revision]);
        await client.query("COMMIT");
        committed = true;
        return updated.rowCount === 1;
      } catch (error) {
        if (client) { try { await client.query("ROLLBACK"); } catch { /* Destroy below; never retry CAS. */ } }
        if (error instanceof LocalProtectionError) throw error;
        return deny("CONTINUITY_UNAVAILABLE");
      } finally {
        try { client?.release(!committed); } catch { deny("CONTINUITY_UNAVAILABLE"); }
      }
    },
  });
  witnessPools.set(witness, options.pool);
  return witness;
}

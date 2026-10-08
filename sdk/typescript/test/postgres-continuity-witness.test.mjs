import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPostgresContinuityWitness, createPostgresExecutionAuthority, protectToolCall } from '../dist/index.js';
const connectionString = process.env.ONCE_TEST_POSTGRES;
if (!connectionString) throw new Error('Disposable PostgreSQL required; proof never skips');
test('durable independent witness and bounded authority admission', async t => {
  const admin = new pg.Pool({ connectionString });
  const names = [0, 1].map(() => `once_witness_${randomUUID().replaceAll('-', '')}`);
  const pools = [];
  for (const name of names) {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(connectionString); url.pathname = `/${name}`;
    pools.push(new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: 1000 }));
  }
  const [pool, witnessPool] = pools;
  t.after(async () => { for (const p of pools) await p.end(); for (const n of names) await admin.query(`DROP DATABASE ${n}`); await admin.end(); });
  await pool.query(readFileSync(new URL('../sql/execution-authority-v1.sql', import.meta.url), 'utf8'));
  await witnessPool.query(readFileSync(new URL('../sql/continuity-witness-v1.sql', import.meta.url), 'utf8'));
  await witnessPool.query("INSERT INTO once_continuity.metadata VALUES(true,'witness-1',1)");
  const witness = createPostgresContinuityWitness({ pool: witnessPool, expectedWitnessId: 'witness-1' });
  const cp = (id, revision) => ({ authorityId: id, generation: 'g1', epoch: '1', revision: String(revision) });
  async function provision() {
    const id = randomUUID();
    await pool.query("INSERT INTO once_execution.authorities VALUES($1,1,'g1',1,0)", [id]);
    await witnessPool.query("INSERT INTO once_continuity.checkpoints VALUES($1,'g1',1,0)", [id]);
    return { pool, witness, authorityId: id, expectedGeneration: 'g1', expectedEpoch: '1' };
  }
  await t.test('concurrent CAS has exactly one durable winner and no implicit checkpoint recreation', async () => {
    const { authorityId: id } = await provision();
    const results = await Promise.all(Array.from({ length: 12 }, () => witness.compareAndAdvance(cp(id, 0), cp(id, 1))));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await witness.compareAndAdvance(cp(id, 0), cp(id, 1)), false);
    assert.equal(await witness.compareAndAdvance(cp('missing', 0), cp('missing', 1)), false);
    assert.equal((await witnessPool.query('SELECT count(*)::int AS n FROM once_continuity.checkpoints WHERE authority_id=$1', ['missing'])).rows[0].n, 0);
    await assert.rejects(witness.compareAndAdvance(cp(id, 1), cp(id, 0)), { code: 'INVALID_WITNESS_REQUEST' });
    const restarted = createPostgresContinuityWitness({ pool: witnessPool, expectedWitnessId: 'witness-1' });
    assert.equal(await restarted.compareAndAdvance(cp(id, 1), cp(id, 2)), true);
  });
  await t.test('wrong witness identity and shared pool deny', async () => {
    const cfg = await provision();
    assert.throws(() => createPostgresExecutionAuthority({ ...cfg, pool: witnessPool }), { code: 'INVALID_CONFIGURATION' });
    const wrong = createPostgresContinuityWitness({ pool: witnessPool, expectedWitnessId: 'wrong' });
    await assert.rejects(wrong.compareAndAdvance(cp(cfg.authorityId, 0), cp(cfg.authorityId, 1)), { code: 'STALE_WITNESS' });
  });
  await t.test('existing kernel replays and conflicts using separate durable SQL witness', async () => {
    const cfg = await provision(); let effects = 0;
    const run = amount => protectToolCall({ operationId: 'refund', effect: { tool: 'fixture.refund', args: { amount } }, authority: createPostgresExecutionAuthority(cfg), execute: async () => { effects++; return { receipt: 'r1' }; } });
    assert.deepEqual(await run(1), { receipt: 'r1' }); assert.deepEqual(await run(1), { receipt: 'r1' });
    await assert.rejects(run(2), { code: 'CONFLICT' }); assert.equal(effects, 1);
  });
  await t.test('restricted runtime roles require row-lock privilege and cannot provision or erase authority', async () => {
    const roles = ['execution', 'witness'].map(kind => `once_${kind}_${randomUUID().replaceAll('-', '')}`);
    const runtimePools = [];
    try {
      for (const role of roles) await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      // These databases are this test's disposable resources only. Explicitly
      // scope CONNECT so the fixture also exercises separate runtime principals.
      for (let i = 0; i < names.length; i++) {
        await admin.query(`REVOKE CONNECT ON DATABASE ${names[i]} FROM PUBLIC`);
        await admin.query(`GRANT CONNECT ON DATABASE ${names[i]} TO ${roles[i]}`);
        const url = new URL(connectionString); url.pathname = `/${names[i]}`; url.username = roles[i];
        runtimePools.push(new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: 1000 }));
      }
      const [executionRuntime, witnessRuntime] = runtimePools;
      await pool.query(`GRANT USAGE ON SCHEMA once_execution TO ${roles[0]};
        GRANT SELECT, UPDATE(revision) ON once_execution.authorities TO ${roles[0]};
        GRANT SELECT, INSERT, UPDATE(state,result_json,owner,lease_until) ON once_execution.operations TO ${roles[0]}`);
      await witnessPool.query(`GRANT USAGE ON SCHEMA once_continuity TO ${roles[1]};
        GRANT SELECT ON once_continuity.metadata TO ${roles[1]};
        GRANT SELECT, UPDATE(revision) ON once_continuity.checkpoints TO ${roles[1]}`);
      const flags = await admin.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)', [roles]);
      assert.equal(flags.rows.length, 2);
      assert.ok(flags.rows.every(row => Object.values(row).every(value => value === false)));
      // PostgreSQL FOR SHARE requires UPDATE on at least one column, even
      // though this code never updates witness metadata. Prove SELECT alone
      // fails, then grant only the CHECK-constrained version column.
      await assert.rejects(witnessRuntime.query('SELECT witness_id,schema_version FROM once_continuity.metadata WHERE singleton=true FOR SHARE'), { code: '42501' });
      await witnessPool.query(`GRANT UPDATE(schema_version) ON once_continuity.metadata TO ${roles[1]}`);
      const cfg = await provision();
      const restrictedWitness = createPostgresContinuityWitness({ pool: witnessRuntime, expectedWitnessId: 'witness-1' });
      const authority = createPostgresExecutionAuthority({ ...cfg, pool: executionRuntime, witness: restrictedWitness });
      let effects = 0;
      const run = amount => protectToolCall({ operationId: 'restricted-refund', effect: { tool: 'fixture.refund', args: { amount } }, authority,
        execute: async () => { effects++; return { receipt: 'restricted-r1' }; } });
      assert.deepEqual(await run(1), { receipt: 'restricted-r1' });
      assert.deepEqual(await run(1), { receipt: 'restricted-r1' });
      await assert.rejects(run(2), { code: 'CONFLICT' });
      assert.equal(effects, 1);
      const denied = async (runtime, statements) => {
        for (const statement of statements) await assert.rejects(runtime.query(statement), { code: '42501' }, statement);
      };
      await denied(executionRuntime, [
        'CREATE TABLE once_execution.forbidden(id text)',
        'DELETE FROM once_execution.operations',
        'TRUNCATE once_execution.operations',
        "INSERT INTO once_execution.authorities VALUES('forbidden',1,'g1',1,0)",
        "UPDATE once_execution.authorities SET generation='forbidden'",
        'CREATE SCHEMA forbidden',
        `CREATE ROLE ${roles[0]}_forbidden`,
      ]);
      await denied(witnessRuntime, [
        'CREATE TABLE once_continuity.forbidden(id text)',
        'DELETE FROM once_continuity.checkpoints',
        'TRUNCATE once_continuity.checkpoints',
        "INSERT INTO once_continuity.checkpoints VALUES('forbidden','g1',1,0)",
        "UPDATE once_continuity.metadata SET witness_id='forbidden'",
      ]);
      await assert.rejects(witnessRuntime.query('UPDATE once_continuity.metadata SET schema_version=2'), { code: '23514' });
      assert.equal(effects, 1);
    } finally {
      for (const runtime of runtimePools) await runtime.end();
      for (const role of roles) {
        await pool.query(`DROP OWNED BY ${role}`);
        await witnessPool.query(`DROP OWNED BY ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
    }
  });
  await t.test('lease expiring during witness acknowledgement cannot dispatch', async () => {
    const cfg = await provision(); const store = await createPostgresExecutionAuthority(cfg).open();
    await store.reserve('id', 'fingerprint', 'owner', 100);
    const slow = { async compareAndAdvance(a,b) { await new Promise(r => setTimeout(r, 150)); return witness.compareAndAdvance(a,b); } };
    const stale = await createPostgresExecutionAuthority({ ...cfg, witness: slow }).open();
    await assert.rejects(stale.assertDispatch('id', 'fingerprint', 'owner'), { code: 'EXECUTION_RIGHT_LOST' });
    await assert.rejects(store.reserve('new', 'f', 'o', 1000), { code: 'CONTINUITY_LOST' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM once_execution.operations WHERE authority_id=$1', [cfg.authorityId])).rows[0].n, 1);
  });
  await t.test('lost acknowledgement is bounded; late CAS never enables retry', async () => {
    const cfg = await provision(); let calls = 0;
    const late = { async compareAndAdvance(a,b) { calls++; await new Promise(r => setTimeout(r, 80)); return witness.compareAndAdvance(a,b); } };
    const store = await createPostgresExecutionAuthority({ ...cfg, witness: late, witnessTimeoutMs: 20 }).open();
    const start = performance.now();
    await assert.rejects(store.reserve('id', 'f', 'o', 1000), { code: 'CONTINUITY_UNAVAILABLE' });
    assert.ok(performance.now() - start < 500);
    await new Promise(r => setTimeout(r, 120)); assert.equal(calls, 1);
    const normal = await createPostgresExecutionAuthority(cfg).open();
    await assert.rejects(normal.reserve('id', 'f', 'o', 1000), { code: 'CONTINUITY_LOST' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM once_execution.operations WHERE authority_id=$1', [cfg.authorityId])).rows[0].n, 0);
  });
});

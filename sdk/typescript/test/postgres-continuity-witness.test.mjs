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

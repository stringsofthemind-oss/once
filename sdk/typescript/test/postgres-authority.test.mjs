import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPostgresExecutionAuthority, protectToolCall, protectLocal, wrapTool } from '../dist/index.js';

// This command deliberately FAILS without a database; no silently skipped proof.
const database = process.env.ONCE_TEST_POSTGRES;
if (!database) throw new Error('Set ONCE_TEST_POSTGRES to a disposable local PostgreSQL admin database. Tests create and drop one isolated test database.');

test('shared PostgreSQL authority adversarial integration', async t => {
  const admin = new pg.Pool({ connectionString: database });
  const dbName = `once_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(database); url.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: url.href, max: 24 });
  const dir = mkdtempSync(join(tmpdir(), 'once-shared-'));
  const effects = join(dir, 'provider.jsonl');
  const witnessDb = new DatabaseSync(join(dir, 'independent-witness.sqlite'));
  witnessDb.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE checkpoints(id TEXT PRIMARY KEY, checkpoint TEXT NOT NULL)');
  let unavailable = false;
  let loseWitnessAck = false;
  const server = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const data = body ? JSON.parse(body) : {};
      if (request.url === '/cas') {
        if (unavailable) { response.writeHead(503).end(); return; }
        const row = witnessDb.prepare('SELECT checkpoint FROM checkpoints WHERE id=?').get(data.expected.authorityId);
        const accepted = !!row && row.checkpoint === JSON.stringify(data.expected);
        if (accepted) witnessDb.prepare('UPDATE checkpoints SET checkpoint=? WHERE id=?').run(JSON.stringify(data.next), data.expected.authorityId);
        if (loseWitnessAck) { request.socket.destroy(); return; }
        response.end(JSON.stringify({ accepted }));
      } else if (request.url === '/effect') {
        const receipt = { receipt: randomUUID(), id: data.id, amount: data.amount };
        appendFileSync(effects, JSON.stringify(receipt) + '\n', { flush: true });
        response.end(JSON.stringify(receipt));
      } else { response.writeHead(404).end(); }
    } catch { response.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fixture = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    try {
      const evidenceDir = process.env.ONCE_TEST_EVIDENCE_DIR;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        const provider = readFileSync(effects, 'utf8');
        writeFileSync(join(evidenceDir, 'provider-journal.jsonl'), provider);
        writeFileSync(join(evidenceDir, 'witness-checkpoints.json'), JSON.stringify(witnessDb.prepare('SELECT checkpoint FROM checkpoints ORDER BY id').all().map(row => JSON.parse(row.checkpoint)), null, 2));
        writeFileSync(join(evidenceDir, 'authority-snapshot.json'), JSON.stringify({
          scope: 'Local controlled fixture; deliberate fault injection included. Not production or real-provider evidence.',
          authorities: (await pool.query('SELECT * FROM once_execution.authorities ORDER BY authority_id')).rows,
          operations: (await pool.query('SELECT * FROM once_execution.operations ORDER BY authority_id,id')).rows,
        }, null, 2));
    }
    } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      witnessDb.close(); await pool.end();
      await admin.query(`DROP DATABASE ${dbName}`); await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await pool.query(readFileSync(new URL('../sql/execution-authority-v1.sql', import.meta.url), 'utf8'));
  const journal = id => { try { return readFileSync(effects, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.id === id); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const witness = { async compareAndAdvance(expected, next) {
    const response = await fetch(`${fixture}/cas`, { method: 'POST', body: JSON.stringify({ expected, next }) });
    if (!response.ok) throw new Error('unavailable');
    return (await response.json()).accepted;
  } };
  async function provision() {
    const authorityId = randomUUID();
    await pool.query('INSERT INTO once_execution.authorities VALUES($1,1,$2,1,0)', [authorityId, 'generation-1']);
    witnessDb.prepare('INSERT INTO checkpoints VALUES(?,?)').run(authorityId, JSON.stringify({ authorityId, generation: 'generation-1', epoch: '1', revision: '0' }));
    return { authorityId, expectedGeneration: 'generation-1', expectedEpoch: '1', pool, witness };
  }
  const authorityFor = config => createPostgresExecutionAuthority(config);
  function run(config, id, extra = {}) {
    return protectToolCall({
      operationId: id, effect: { tool: 'fixture.account-A.refund', args: { id, amount: 100 } }, authority: authorityFor(config),
      execute: async ({ args }) => (await fetch(`${fixture}/effect`, { method: 'POST', body: JSON.stringify(args) })).json(),
      ...extra,
    });
  }
  function child(config, id, extra = {}) {
    return new Promise((resolve, reject) => {
      const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL('./shared-authority-worker.mjs', import.meta.url))], {
        windowsHide: true, env: { ...globalThis.process.env, ONCE_TEST_DATABASE: url.href, ONCE_TEST_WORKER: JSON.stringify({ fixture, authorityId: config.authorityId, id, ...extra }) },
      });
      let stdout = '', stderr = '';
      process.stdout.on('data', chunk => stdout += chunk); process.stderr.on('data', chunk => stderr += chunk);
      process.on('error', reject);
      process.on('exit', code => {
        if (((extra.crash && stdout === 'CRASH_AFTER_PROVIDER_COMMIT') || (extra.crashBefore && stdout === 'CRASH_BEFORE_PROVIDER_DISPATCH')) && code !== 0) resolve({ crash: true });
        else if (code !== 0) reject(new Error(`Test child failed: ${stderr}`));
        else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
      });
    });
  }

  await t.test('eight separate workers have one winner; restart replays and changed effects conflict', async () => {
    const c = await provision(), id = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => child(c, id)));
    assert(results.some(x => x.result));
    assert(results.every(x => x.result || x.code === 'IN_FLIGHT'));
    assert.equal(journal(id).length, 1);
    assert.deepEqual((await child(c, id)).result, journal(id)[0]);
    assert.equal((await child(c, id, { amount: 200 })).code, 'CONFLICT');
    await assert.rejects(run(c, id, { effect: { tool: 'fixture.account-B.refund', args: { id, amount: 100 } } }), { code: 'CONFLICT' });
    assert.equal(journal(id).length, 1);
  });

  await t.test('process death after provider commit blocks fresh workers until authoritative reconciliation', async () => {
    const c = await provision(), id = randomUUID();
    assert.deepEqual(await child(c, id, { crash: true }), { crash: true });
    await pool.query('UPDATE once_execution.operations SET lease_until=0 WHERE authority_id=$1', [c.authorityId]);
    assert.equal((await child(c, id)).code, 'UNKNOWN');
    for (const status of ['NOT_FOUND', 'UNKNOWN']) {
      await assert.rejects(run(c, id, { reconcile: () => ({ status }) }), { code: 'UNKNOWN' });
    }
    await assert.rejects(run(c, id, { reconcile: () => { throw new Error('lookup outage'); } }), { code: 'UNKNOWN' });
    assert.equal(journal(id).length, 1);
    const truth = journal(id)[0]; // Independent fixture-provider durable journal is authoritative here only.
    assert.deepEqual(await run(c, id, { reconcile: () => ({ status: 'CONFIRMED', result: truth }) }), truth);
    assert.deepEqual((await child(c, id)).result, truth);
    assert.equal(journal(id).length, 1);
  });

  await t.test('lost acknowledgement and invalid receipts never permit redispatch', async () => {
    const c = await provision(), id = randomUUID();
    await assert.rejects(run(c, id, { execute: async ({ args }) => {
      await fetch(`${fixture}/effect`, { method: 'POST', body: JSON.stringify(args) }); throw new Error('lost ack');
    } }), { code: 'UNKNOWN' });
    await assert.rejects(run(c, id), { code: 'UNKNOWN' });
    await assert.rejects(run(c, id, { reconcile: () => ({ status: 'CONFIRMED' }) }), { code: 'UNKNOWN' });
    assert.equal(journal(id).length, 1);
  });

  await t.test('crash after reservation but before dispatch remains blocked after restart', async () => {
    const c = await provision(), id = randomUUID();
    assert.deepEqual(await child(c, id, { crashBefore: true }), { crash: true });
    await pool.query('UPDATE once_execution.operations SET lease_until=0 WHERE authority_id=$1', [c.authorityId]);
    assert.equal((await child(c, id)).code, 'UNKNOWN');
    assert.equal(journal(id).length, 0);
  });

  await t.test('stale worker finishing after expiry cannot confirm or trigger a new effect', async () => {
    const c = await provision(), id = randomUUID();
    await assert.rejects(run(c, id, { execute: async ({ args }) => {
      const receipt = await (await fetch(`${fixture}/effect`, { method: 'POST', body: JSON.stringify(args) })).json();
      await pool.query('UPDATE once_execution.operations SET lease_until=0 WHERE authority_id=$1', [c.authorityId]);
      await assert.rejects(run(c, id), { code: 'UNKNOWN' });
      return receipt;
    } }), { code: 'EXECUTION_RIGHT_LOST' });
    await assert.rejects(run(c, id), { code: 'UNKNOWN' });
    assert.equal(journal(id).length, 1);
  });

  await t.test('authority epoch drift before dispatch blocks callback; after dispatch cannot confirm', async () => {
    const c = await provision(), store = await authorityFor(c).open(), id = randomUUID();
    const authority = { async open() { return { ...store, async reserve(...args) {
      const result = await store.reserve(...args);
      await pool.query('UPDATE once_execution.authorities SET epoch=2 WHERE authority_id=$1', [c.authorityId]);
      return result;
    } }; } };
    await assert.rejects(run(c, id, { authority }), { code: 'STALE_AUTHORITY' });
    assert.equal(journal(id).length, 0);
    const c2 = await provision(), id2 = randomUUID();
    await assert.rejects(run(c2, id2, { execute: async ({ args }) => {
      const receipt = await (await fetch(`${fixture}/effect`, { method: 'POST', body: JSON.stringify(args) })).json();
      await pool.query('UPDATE once_execution.authorities SET epoch=2 WHERE authority_id=$1', [c2.authorityId]);
      return receipt;
    } }), error => error.code === 'UNKNOWN' && error.cause.code === 'STALE_AUTHORITY');
    await assert.rejects(run(c2, id2), { code: 'STALE_AUTHORITY' });
    assert.equal(journal(id2).length, 1);
  });

  await t.test('concurrent reconciliation retains the first durable provider receipt', async () => {
    const c = await provision(), id = randomUUID();
    await assert.rejects(run(c, id, { execute: async () => { throw new Error('uncertain'); } }), { code: 'UNKNOWN' });
    const recovered = await Promise.all(Array.from({ length: 8 }, () => run(c, id, {
      reconcile: () => ({ status: 'CONFIRMED', result: { receipt: 'same-authoritative-result' } }),
    })));
    assert(recovered.every(x => x.receipt === 'same-authoritative-result'));
    assert.equal(journal(id).length, 0);
  });

  await t.test('expired reservation is not reassigned; stale owners cannot dispatch or confirm', async () => {
    const c = await provision(), store = await authorityFor(c).open(), id = randomUUID();
    assert.equal((await store.reserve(id, 'fingerprint', 'worker-A', 30000)).dispatch, true);
    await pool.query('UPDATE once_execution.operations SET lease_until=0 WHERE authority_id=$1', [c.authorityId]);
    await assert.rejects(store.assertDispatch(id, 'fingerprint', 'worker-A'), { code: 'EXECUTION_RIGHT_LOST' });
    const retry = await store.reserve(id, 'fingerprint', 'worker-B', 30000);
    assert.equal(retry.dispatch, false); assert.equal(retry.row.state, 'UNKNOWN');
    assert.equal(await store.confirm(id, 'fingerprint', 'worker-A', '{"hasValue":false}'), false);
    assert.equal(journal(id).length, 0);
  });

  await t.test('fence loss between reservation and dispatch blocks the callback', async () => {
    const c = await provision(), store = await authorityFor(c).open(), id = randomUUID();
    const authority = { async open() { return { ...store, async reserve(...args) {
      const result = await store.reserve(...args);
      await pool.query("UPDATE once_execution.operations SET state='UNKNOWN',owner=NULL,lease_until=NULL WHERE authority_id=$1", [c.authorityId]);
      return result;
    } }; } };
    await assert.rejects(run(c, id, { authority }), { code: 'EXECUTION_RIGHT_LOST' });
    assert.equal(journal(id).length, 0);
  });

  await t.test('older valid history is rejected by independent witness, even for a new identity', async () => {
    const c = await provision(), id = randomUUID();
    await run(c, id);
    // Simulate restoring the complete earlier empty authority history.
    await pool.query('DELETE FROM once_execution.operations WHERE authority_id=$1', [c.authorityId]);
    await pool.query('UPDATE once_execution.authorities SET revision=0 WHERE authority_id=$1', [c.authorityId]);
    await assert.rejects(run(c, id), { code: 'CONTINUITY_LOST' });
    await assert.rejects(run(c, randomUUID()), { code: 'CONTINUITY_LOST' });
    assert.equal(journal(id).length, 1);
    assert.equal((await pool.query('SELECT * FROM once_execution.operations WHERE authority_id=$1', [c.authorityId])).rowCount, 0);
  });

  await t.test('missing authority is not recreated and wrong schema/generation/epoch fail closed', async () => {
    const c = await provision(), id = randomUUID();
    for (const change of [{ expectedGeneration: 'other' }, { expectedEpoch: '0' }]) {
      await assert.rejects(run({ ...c, ...change }, id), { code: 'STALE_AUTHORITY' });
    }
    await pool.query('DELETE FROM once_execution.authorities WHERE authority_id=$1', [c.authorityId]);
    await assert.rejects(run(c, id), { code: 'AUTHORITY_MISSING' });
    assert.equal((await pool.query('SELECT * FROM once_execution.authorities WHERE authority_id=$1', [c.authorityId])).rowCount, 0);
    assert.equal(journal(id).length, 0);
  });

  await t.test('witness outage blocks execution and replay; missing witness state is never bootstrapped', async () => {
    const c = await provision(), id = randomUUID(); await run(c, id);
    unavailable = true;
    try {
      await assert.rejects(run(c, id), { code: 'CONTINUITY_UNAVAILABLE' });
      await assert.rejects(run(c, randomUUID()), { code: 'CONTINUITY_UNAVAILABLE' });
    } finally { unavailable = false; }
    witnessDb.prepare('DELETE FROM checkpoints WHERE id=?').run(c.authorityId);
    await assert.rejects(run(c, id), { code: 'CONTINUITY_LOST' });
    assert.equal(journal(id).length, 1);
  });

  await t.test('lost witness acknowledgement leaves witness ahead and blocks all subsequent work', async () => {
    const c = await provision(), id = randomUUID(); loseWitnessAck = true;
    try { await assert.rejects(run(c, id), { code: 'CONTINUITY_UNAVAILABLE' }); }
    finally { loseWitnessAck = false; }
    await assert.rejects(run(c, id), { code: 'CONTINUITY_LOST' });
    assert.equal(journal(id).length, 0);
  });

  await t.test('database commit failure after witness advancement never dispatches or retries CAS', async () => {
    const c = await provision(), id = randomUUID(); let commits = 0;
    const broken = { async connect() {
      const client = await pool.connect();
      return { release: destroy => client.release(destroy), async query(sql, args) {
        if (sql === 'COMMIT') { commits++; throw new Error('synthetic commit failure'); }
        return client.query(sql, args);
      } };
    } };
    await assert.rejects(run({ ...c, pool: broken }, id), { code: 'STATE_UNAVAILABLE' });
    assert.equal(commits, 1);
    await assert.rejects(run(c, id), { code: 'CONTINUITY_LOST' });
    assert.equal(journal(id).length, 0);
  });

  await t.test('confirmation COMMIT acknowledgement loss returns UNKNOWN then replays durable truth', async () => {
    const c = await provision(), id = randomUUID(); let commits = 0;
    const lostAck = { async connect() {
      const client = await pool.connect();
      return { release: destroy => client.release(destroy), async query(sql, args) {
        const result = await client.query(sql, args);
        if (sql === 'COMMIT' && ++commits === 3) throw new Error('lost COMMIT acknowledgement');
        return result;
      } };
    } };
    await assert.rejects(run({ ...c, pool: lostAck }, id), { code: 'UNKNOWN' });
    assert.deepEqual(await run(c, id), journal(id)[0]); assert.equal(journal(id).length, 1);
  });

  await t.test('missing operations table is not recreated and unsupported schema version is denied', async () => {
    const c = await provision(), id = randomUUID();
    await pool.query('ALTER TABLE once_execution.operations RENAME TO unavailable_operations');
    try { await assert.rejects(run(c, id), { code: 'STATE_UNAVAILABLE' }); }
    finally { await pool.query('ALTER TABLE once_execution.unavailable_operations RENAME TO operations'); }
    await pool.query('ALTER TABLE once_execution.authorities DROP CONSTRAINT authorities_schema_version_check');
    await pool.query('UPDATE once_execution.authorities SET schema_version=2 WHERE authority_id=$1', [c.authorityId]);
    await assert.rejects(run(c, id), { code: 'STALE_AUTHORITY' });
    await pool.query('UPDATE once_execution.authorities SET schema_version=1 WHERE authority_id=$1', [c.authorityId]);
    await pool.query('ALTER TABLE once_execution.authorities ADD CONSTRAINT authorities_schema_version_check CHECK(schema_version=1)');
    assert.equal(journal(id).length, 0);
  });

  await t.test('state unavailable does not fallback and driver secrets are not exposed', async () => {
    const c = await provision(), id = randomUUID();
    const unavailablePool = { async connect() { throw new Error('password=synthetic-secret'); } };
    await assert.rejects(run({ ...c, pool: unavailablePool }, id), error => {
      assert.equal(error.code, 'STATE_UNAVAILABLE');
      assert(!JSON.stringify(error).includes('synthetic-secret')); assert.equal(error.cause, undefined); return true;
    });
    assert.equal(journal(id).length, 0);
    assert.throws(() => protectLocal(async () => {}, { id: () => id, payload: () => ({}), statePath: 'unused', authority: authorityFor(c) }), { code: 'INVALID_CONFIGURATION' });
  });

  await t.test('wrapTool uses shared kernel and exact frozen effect arguments', async () => {
    const c = await provision(), id = randomUUID(); let count = 0;
    const wrapped = wrapTool(async args => { assert(Object.isFrozen(args)); count++; return args; }, {
      operationId: input => input.id, effect: input => ({ tool: 'fixed.account-A', args: input }), authority: authorityFor(c),
    });
    assert.deepEqual(await wrapped({ id, amount: 1 }), { id, amount: 1 });
    await wrapped({ id, amount: 1 }); assert.equal(count, 1);
    await assert.rejects(wrapped({ id, amount: 2 }), { code: 'CONFLICT' });
  });
});

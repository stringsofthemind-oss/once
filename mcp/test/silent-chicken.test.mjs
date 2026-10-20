import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { watch, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { EMPTY_HOST_AUTHORITY_DIGEST, admitPostgresIntent, createPostgresContinuityWitness, createPostgresIntentAuthority } from '@once-agent/sdk';
import { startOrderProvider } from './fixtures/order-provider.mjs';

const executionUrl = process.env.ONCE_TEST_POSTGRES, witnessUrl = process.env.ONCE_TEST_WITNESS;
if (!executionUrl || !witnessUrl) throw Error('Two separately provisioned disposable PostgreSQL clusters required; no skip or SQLite fallback.');
const root = process.env.ONCE_HARDENING_RESULTS ?? mkdtempSync(path.join(tmpdir(), 'once-hardening-'));
mkdirSync(root, { recursive: true });
const events = [], scenarios = [], latencies = [];
const log = (event, data = {}) => events.push({ sequence: events.length + 1, at: new Date().toISOString(), event, ...JSON.parse(JSON.stringify(data)) });
const order = { sku: 'SKU-1', quantity: 2, destinationId: 'address-1' };
const effect = { tool: 'once_create_order', args: { contract: 'once-registered-order-v1', action: 'once_create_order', authority: { provider: 'disposable-orders', accountId: 'account-A', environment: 'local-test' }, resourceId: 'orders-local', providerArgs: order } };
const input = (operationId, args = order) => ({ operationId, args });
const hostPath = fileURLToPath(new URL('./fixtures/order-host.mjs', import.meta.url));
function marker(filename) {
  return new Promise((resolve, reject) => {
    let observer; const timer = setTimeout(() => { observer?.close(); reject(Error('worker barrier timed out')); }, 10000);
    const check = () => { if (existsSync(filename)) { try { const value = JSON.parse(readFileSync(filename)); clearTimeout(timer); observer?.close(); resolve(value); } catch {} } };
    observer = watch(path.dirname(filename), check); check();
  });
}

test('Silent Chicken: admitted intent and independent authority continuity', { timeout: 180000 }, async t => {
  const admins = [new pg.Pool({ connectionString: executionUrl }), new pg.Pool({ connectionString: witnessUrl })];
  const names = [0, 1].map(() => `once_hardening_${randomUUID().replaceAll('-', '')}`);
  for (let i = 0; i < 2; i++) await admins[i].query(`CREATE DATABASE ${names[i]}`);
  const urls = [executionUrl, witnessUrl].map((base, i) => { const url = new URL(base); url.pathname = `/${names[i]}`; return url; });
  const pools = urls.map(url => new pg.Pool({ connectionString: url.href }));
  const [pool, witnessPool] = pools;
  // This is explicit test provisioning, distinct from runtime recovery.
  const sqlRoot = process.env.ONCE_SQL_ROOT ?? fileURLToPath(new URL('../../sdk/typescript/sql/', import.meta.url));
  await pool.query(readFileSync(path.join(sqlRoot, 'execution-authority-v1.sql'), 'utf8'));
  await pool.query(readFileSync(path.join(sqlRoot, 'execution-host-intents-v2.sql'), 'utf8'));
  await witnessPool.query(readFileSync(path.join(sqlRoot, 'continuity-witness-v1.sql'), 'utf8'));
  await witnessPool.query(readFileSync(path.join(sqlRoot, 'continuity-witness-v2.sql'), 'utf8'));
  const witnessId = randomUUID();
  await witnessPool.query('INSERT INTO once_continuity.metadata VALUES(true,$1,2)', [witnessId]);
  const roles = [0, 1, 2].map(() => `once_role_${randomUUID().replaceAll('-', '')}`);
  for (let i = 0; i < roles.length; i++) await admins[i === 2 ? 1 : 0].query(`CREATE ROLE ${roles[i]} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-only-runtime'`);
  for (const role of roles.slice(0, 2)) {
    await pool.query(`GRANT USAGE ON SCHEMA once_execution TO ${role}`);
    await pool.query(`GRANT SELECT,UPDATE(revision,state_digest) ON once_execution.authorities TO ${role}`);
    await pool.query(`GRANT SELECT ON once_execution.host_intents TO ${role}`);
  }
  await pool.query(`GRANT SELECT,INSERT,UPDATE(state,result_json,owner,lease_until) ON once_execution.operations TO ${roles[0]}`);
  await pool.query(`GRANT SELECT ON once_execution.operations TO ${roles[1]}`);
  await pool.query(`GRANT INSERT ON once_execution.host_intents TO ${roles[1]}`);
  await witnessPool.query(`GRANT USAGE ON SCHEMA once_continuity TO ${roles[2]}`);
  await witnessPool.query(`GRANT SELECT,UPDATE(schema_version) ON once_continuity.metadata TO ${roles[2]}`);
  await witnessPool.query(`GRANT SELECT,UPDATE(revision,state_digest) ON once_continuity.checkpoints TO ${roles[2]}`);
  const runtimeUrls = [urls[0], urls[0], urls[1]].map((url, i) => { const copy = new URL(url); copy.username = roles[i]; copy.password = 'fixture-only-runtime'; return copy.href; });
  const [runtimePool, admissionPool, runtimeWitnessPool] = runtimeUrls.map(connectionString => new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 }));
  const allPools = [...pools, runtimePool, admissionPool, runtimeWitnessPool];
  for (const p of [...admins, ...allPools]) p.on('error', () => {});
  const witness = createPostgresContinuityWitness({ pool: runtimeWitnessPool, expectedWitnessId: witnessId, expectedSchemaVersion: 2 });
  const provider = await startOrderProvider(path.join(root, 'provider.jsonl'), {
    onCommit: receipt => log('provider-commit-fsynced', { receipt }),
    onAckDropped: receipt => log('provider-ack-dropped', { operationId: receipt.operationId }),
  });
  const hosts = new Set(); let attempts = 0;
  const stop = async h => { await h.client.close(); hosts.delete(h); };
  t.after(async () => {
    for (const h of hosts) await stop(h);
    await provider.close();
    writeFileSync(path.join(root, 'provider-counters.json'), JSON.stringify(provider.counters, null, 2));
    const snapshot = { authorities: (await pool.query('SELECT * FROM once_execution.authorities ORDER BY authority_id')).rows,
      intents: (await pool.query('SELECT * FROM once_execution.host_intents ORDER BY authority_id,scope,intent_key')).rows,
      operations: (await pool.query('SELECT * FROM once_execution.operations ORDER BY authority_id,id')).rows,
      checkpoints: (await witnessPool.query('SELECT * FROM once_continuity.checkpoints ORDER BY authority_id')).rows };
    writeFileSync(path.join(root, 'authority-snapshot.json'), JSON.stringify(snapshot, null, 2));
    writeFileSync(path.join(root, 'events.jsonl'), events.map(x => JSON.stringify(x)).join('\n') + '\n');
    const sorted = latencies.map(x => x.ms).sort((a, b) => a - b);
    writeFileSync(path.join(root, 'results.json'), JSON.stringify({ schema: 'once-silent-chicken-v1', runtime: process.version, platform: process.platform,
      passed: scenarios.filter(x => x.status === 'PASS').length, failed: scenarios.filter(x => x.status === 'FAIL').length, scenarios,
      success: scenarios.length === 12 && scenarios.every(x => x.status === 'PASS'), providerEffects: provider.records().length,
      latencies, measuredMcpCallLatencyMs: { samples: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * .95)] },
      driverMemory: process.memoryUsage(), scope: 'two local authenticated PostgreSQL clusters on one physical Windows host; restricted runtime/admission/witness roles; isolated non-idempotent provider' }, null, 2));
    for (const p of allPools) await p.end();
    for (let i = 0; i < 2; i++) await admins[i].query(`DROP DATABASE ${names[i]}`);
    for (let i = 0; i < roles.length; i++) await admins[i === 2 ? 1 : 0].query(`DROP ROLE ${roles[i]}`);
    for (const p of admins) await p.end();
    console.log(`Hardening evidence: ${root}`);
  });
  async function provision(key = 'trusted-task/slot-A') {
    const authorityId = randomUUID();
    await pool.query("INSERT INTO once_execution.authorities VALUES($1,2,'generation-1',1,0,$2)", [authorityId, EMPTY_HOST_AUTHORITY_DIGEST]);
    await witnessPool.query("INSERT INTO once_continuity.checkpoints VALUES($1,'generation-1',1,0,$2)", [authorityId, EMPTY_HOST_AUTHORITY_DIGEST]);
    const base = { authorityId, expectedGeneration: 'generation-1', expectedEpoch: '1', witness };
    const begin = performance.now();
    const binding = await admitPostgresIntent({ ...base, pool: admissionPool }, { scope: 'host-scope', intentKey: key, effect });
    log('host-intent-admitted', { binding, admissionMs: performance.now() - begin });
    return { ...base, binding, key, runtime: createPostgresIntentAuthority({ ...base, pool: runtimePool }),
      shared: { executionUrl: runtimeUrls[0], witnessUrl: runtimeUrls[2], witnessId, authorityId, generation: 'generation-1', epoch: '1', scope: 'host-scope' } };
  }
  async function connect(cfg, extras = {}) {
    const attemptId = `replacement-${++attempts}-${randomUUID()}`, sessionId = randomUUID();
    const config = { providerUrl: provider.url, token: provider.token, accountId: 'account-A', resourceId: 'orders-local', shared: cfg.shared, trustedIntentKey: cfg.key, leaseMs: 300,
      metricsPath: path.join(root, `${attemptId}-metrics.json`), ...extras };
    const transport = new StdioClientTransport({ command: process.execPath, args: [hostPath], env: { ...process.env, ONCE_TEST_HOST: JSON.stringify(config) }, stderr: 'pipe' });
    let diagnostics = ''; transport.stderr.on('data', chunk => { diagnostics += chunk; });
    const send = transport.send.bind(transport);
    transport.send = message => { if (message.method === 'tools/call') log('mcp-request', { attemptId, sessionId, pid: transport.pid, requestId: message.id, operationId: message.params.arguments.operationId }); return send(message); };
    const client = new Client({ name: attemptId, version: '1' });
    const handle = { client, transport, attemptId, sessionId, call: async x => {
      const begin = performance.now();
      const response = await client.callTool({ name: 'once_create_order', arguments: x }, { timeout: 10000 });
      const result = JSON.parse(response.content[0].text); assert.deepEqual(response.structuredContent, result);
      const ms = performance.now() - begin; latencies.push({ status: result.status, ms });
      log('mcp-outcome', { attemptId, sessionId, operationId: x.operationId, result, ms }); return result;
    } };
    hosts.add(handle);
    try { await client.connect(transport); await client.ping(); return handle; }
    catch { await stop(handle); throw Error(`Fixture host startup rejected: ${diagnostics}`); }
  }
  const counts = () => ({ posts: provider.counters.posts, effects: provider.records().length });
  const noWrites = async fn => { const before = counts(); await fn(); assert.deepEqual(counts(), before); };
  const oneEffect = id => { assert.equal(provider.records().filter(x => x.operationId === id).length, 1); };
  const expire = async cfg => {
    for (let i = 0; i < 100; i++) {
      const { rows } = await pool.query('SELECT lease_until <= floor(extract(epoch FROM clock_timestamp())*1000) AS expired FROM once_execution.operations WHERE authority_id=$1 AND id=$2', [cfg.authorityId, cfg.binding.operationId]);
      if (rows[0]?.expired) return;
      await delay(20);
    }
    throw Error('real database lease did not expire');
  };
  const check = async (id, title, fn) => t.test(`${id}: ${title}`, async () => {
    const row = { id, title, status: 'RUNNING' }; scenarios.push(row); log('scenario-start', { id });
    try { await fn(); row.status = 'PASS'; } catch (error) { row.status = 'FAIL'; row.error = error.message; throw error; }
    finally { log('scenario-end', { ...row, ...counts() }); }
  });

  await check('H01', 'T06 fresh planner ID denied; separately admitted identical intent executes', async () => {
    const cfg = await provision(); let host = await connect(cfg);
    provider.modes.set(cfg.binding.operationId, 'lost-ack'); provider.observations.set(cfg.binding.operationId, { status: 'UNKNOWN' });
    assert.equal((await host.call(input(cfg.binding.operationId))).code, 'UNKNOWN'); await stop(host);
    host = await connect(cfg);
    await noWrites(async () => {
      assert.equal((await host.call(input(`planner-${randomUUID()}`))).code, 'IDENTITY_CONFLICT');
      assert.equal((await host.call(input(cfg.binding.operationId))).code, 'UNKNOWN');
      const unknownSlot = await connect({ ...cfg, key: 'planner-invented-slot' });
      assert.equal((await unknownSlot.call(input(`planner-${randomUUID()}`))).code, 'INTENT_REQUIRED');
    });
    oneEffect(cfg.binding.operationId);
    const next = await admitPostgresIntent({ ...cfg, pool: admissionPool }, { scope: 'host-scope', intentKey: 'trusted-task/intentional-new-slot', effect });
    log('separately-authorized-new-intent', { binding: next });
    assert.notEqual(next.operationId, cfg.binding.operationId);
    const intentional = await connect({ ...cfg, key: next.intentKey });
    assert.equal((await intentional.call(input(next.operationId))).status, 'CONFIRMED'); oneEffect(next.operationId);
  });
  await check('H02', 'T07 empty replacement execution authority denied; matching original history recovers', async () => {
    const cfg = await provision(); let host = await connect(cfg);
    assert.equal((await host.call(input(cfg.binding.operationId))).status, 'CONFIRMED'); await stop(host);
    const meta = (await pool.query('SELECT * FROM once_execution.authorities WHERE authority_id=$1', [cfg.authorityId])).rows[0];
    const operation = (await pool.query('SELECT * FROM once_execution.operations WHERE authority_id=$1', [cfg.authorityId])).rows[0];
    // Strong partial-restore attack: preserve CURRENT metadata/revision/root
    // but remove operations. A revision-only witness incorrectly accepts this.
    await pool.query('DELETE FROM once_execution.operations WHERE authority_id=$1', [cfg.authorityId]);
    host = await connect(cfg);
    await noWrites(async () => assert.equal((await host.call(input(cfg.binding.operationId))).code, 'CONTINUITY_LOST'));
    // Rehashing the replacement locally is also insufficient: the separately
    // authenticated witness still pins the original contents, not this checksum.
    const forgedRoot = createHash('sha256').update(JSON.stringify({ contract: 'once-authority-state-v2', operations: [], intents: [[cfg.binding.scope,cfg.key,cfg.binding.operationId,cfg.binding.effectFingerprint]] })).digest('hex');
    await pool.query('UPDATE once_execution.authorities SET state_digest=$2 WHERE authority_id=$1', [cfg.authorityId, forgedRoot]);
    await noWrites(async () => assert.equal((await host.call(input(cfg.binding.operationId))).code, 'CONTINUITY_LOST'));
    await pool.query('UPDATE once_execution.authorities SET revision=0 WHERE authority_id=$1', [cfg.authorityId]);
    await noWrites(async () => assert.equal((await host.call(input(cfg.binding.operationId))).code, 'CONTINUITY_LOST'));
    await stop(host);
    // Explicit fixture restoration of the EXACT original execution snapshot.
    await pool.query('UPDATE once_execution.authorities SET revision=$2,state_digest=$3 WHERE authority_id=$1', [cfg.authorityId, meta.revision, meta.state_digest]);
    await pool.query('INSERT INTO once_execution.operations(authority_id,id,fingerprint,state,result_json,owner,lease_until) VALUES($1,$2,$3,$4,$5,$6,$7)', [operation.authority_id, operation.id, operation.fingerprint, operation.state, operation.result_json, operation.owner, operation.lease_until]);
    host = await connect(cfg);
    await noWrites(async () => assert.equal((await host.call(input(cfg.binding.operationId))).status, 'CONFIRMED'));
    oneEffect(cfg.binding.operationId);
  });
  await check('H03', 'commit/drop acknowledgement/real kill/repeated replacements/read-only reconciliation', async () => {
    const cfg = await provision(); const file = path.join(root, 'commit-crash-marker.json');
    provider.modes.set(cfg.binding.operationId, 'lost-ack'); provider.observations.set(cfg.binding.operationId, { status: 'UNKNOWN' });
    const first = await connect(cfg, { afterAckLossMarker: file });
    const barrier = marker(file), pending = first.call(input(cfg.binding.operationId)).catch(() => undefined);
    const observed = await barrier; process.kill(first.transport.pid, 'SIGKILL'); await pending; await stop(first);
    log('worker-killed-after-provider-commit', observed); oneEffect(cfg.binding.operationId); await expire(cfg);
    await noWrites(async () => {
      for (let i = 0; i < 3; i++) { const replacement = await connect(cfg); const r = await replacement.call(input(cfg.binding.operationId)); assert.equal(r.code, 'UNKNOWN'); assert.equal(r.retryAllowed, false); await stop(replacement); }
      provider.observations.delete(cfg.binding.operationId); const recovery = await connect(cfg);
      const confirmed = await recovery.call(input(cfg.binding.operationId)); assert.equal(confirmed.status, 'CONFIRMED');
      assert.deepEqual(confirmed.result, provider.records().find(x => x.operationId === cfg.binding.operationId));
      await stop(recovery); const replay = await connect(cfg); const reads = provider.counters.lookups;
      assert.deepEqual(await replay.call(input(cfg.binding.operationId)), confirmed); assert.equal(provider.counters.lookups, reads);
    });
  });
  await check('H04', 'crash after reserved authority before provider effect stays UNKNOWN, not guessed success', async () => {
    const cfg = await provision(); const file = path.join(root, 'before-provider-marker.json');
    const first = await connect(cfg, { beforeProviderMarker: file });
    const before = counts(); const barrier = marker(file), pending = first.call(input(cfg.binding.operationId)).catch(() => undefined);
    await barrier; process.kill(first.transport.pid, 'SIGKILL'); await pending; await stop(first); assert.deepEqual(counts(), before);
    await expire(cfg); const replacement = await connect(cfg);
    await noWrites(async () => { assert.equal((await replacement.call(input(cfg.binding.operationId))).code, 'UNKNOWN'); });
    const row = (await pool.query('SELECT state FROM once_execution.operations WHERE authority_id=$1 AND id=$2', [cfg.authorityId, cfg.binding.operationId])).rows[0];
    assert.equal(row.state, 'UNKNOWN'); assert.equal(provider.records().filter(x => x.operationId === cfg.binding.operationId).length, 0);
  });
  await check('H05', 'host-admitted intent alone is not a receipt; unused admission can execute once', async () => {
    const cfg = await provision(); const first = await connect(cfg); process.kill(first.transport.pid, 'SIGKILL'); await stop(first); // real termination before any call/reservation
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM once_execution.operations WHERE authority_id=$1', [cfg.authorityId])).rows[0].n, 0);
    const replacement = await connect(cfg); assert.equal((await replacement.call(input(cfg.binding.operationId))).status, 'CONFIRMED'); oneEffect(cfg.binding.operationId);
  });
  await check('H06', 'simultaneous fresh workers have one execution owner', async () => {
    const cfg = await provision(); const hosts = await Promise.all(Array.from({ length: 6 }, () => connect(cfg, { leaseMs: 5000 })));
    const results = await Promise.all(hosts.map(h => h.call(input(cfg.binding.operationId))));
    assert.ok(results.some(x => x.status === 'CONFIRMED')); assert.ok(results.every(x => x.status === 'CONFIRMED' || x.code === 'IN_FLIGHT'));
    oneEffect(cfg.binding.operationId);
  });
  await check('H07', 'SKU/quantity/destination/resource/account/tool drift remain CONFLICT', async () => {
    const cfg = await provision(); const host = await connect(cfg); assert.equal((await host.call(input(cfg.binding.operationId))).status, 'CONFIRMED');
    await noWrites(async () => {
      for (const args of [{ ...order, sku: 'SKU-2' }, { ...order, quantity: 3 }, { ...order, destinationId: 'address-2' }]) assert.equal((await host.call(input(cfg.binding.operationId, args))).code, 'CONFLICT');
      const changed = await connect(cfg, { resourceId: 'other-resource' }); assert.equal((await changed.call(input(cfg.binding.operationId))).code, 'CONFLICT');
      provider.setAccount('account-B'); const account = await connect(cfg, { accountId: 'account-B' }); assert.equal((await account.call(input(cfg.binding.operationId))).code, 'CONFLICT'); provider.setAccount('account-A');
      const renamed = await connect(cfg, { name: 'once_other_order' });
      const response = await renamed.client.callTool({ name: 'once_other_order', arguments: input(cfg.binding.operationId) }); assert.equal(JSON.parse(response.content[0].text).code, 'CONFLICT');
    });
  });
  await check('H08', 'socket-failed, ABSENT and forged/mismatched evidence cannot confirm', async () => {
    const cfg = await provision(); const host = await connect(cfg);
    provider.modes.set(cfg.binding.operationId, 'lost-ack'); assert.equal((await host.call(input(cfg.binding.operationId))).code, 'UNKNOWN');
    const receipt = provider.records().find(x => x.operationId === cfg.binding.operationId);
    const valid = { status: 'CONFIRMED', authoritative: true, complete: true, observedAt: Date.now(), receipt };
    await noWrites(async () => {
      for (const observation of [new Error('socket failed'), { status: 'ABSENT' }, { status: 'UNKNOWN' }, { ...valid, authoritative: false }, { ...valid, complete: false }, { ...valid, observedAt: Date.now() - 60000 }, { ...valid, receipt: { ...receipt, operationId: 'forged' } }, { ...valid, receipt: { ...receipt, effect: { ...receipt.effect, providerArgs: { ...order, quantity: 3 } } } }]) {
        provider.observations.set(cfg.binding.operationId, observation); assert.equal((await host.call(input(cfg.binding.operationId))).code, 'UNKNOWN');
      }
    });
    oneEffect(cfg.binding.operationId);
  });
  await check('H09', 'missing/rewound/mismatched witness and unavailable authority fail closed', async () => {
    const cfg = await provision(); const host = await connect(cfg);
    const cp = (await witnessPool.query('SELECT * FROM once_continuity.checkpoints WHERE authority_id=$1', [cfg.authorityId])).rows[0];
    await witnessPool.query('DELETE FROM once_continuity.checkpoints WHERE authority_id=$1', [cfg.authorityId]);
    await noWrites(async () => assert.equal((await host.call(input(cfg.binding.operationId))).code, 'CONTINUITY_LOST'));
    await witnessPool.query('INSERT INTO once_continuity.checkpoints VALUES($1,$2,$3,0,$4)', [cp.authority_id, cp.generation, cp.epoch, cp.state_digest]);
    await noWrites(async () => assert.equal((await host.call(input(cfg.binding.operationId))).code, 'CONTINUITY_LOST'));
    await witnessPool.query('UPDATE once_continuity.checkpoints SET revision=$2,generation=$3 WHERE authority_id=$1', [cfg.authorityId, cp.revision, 'wrong-generation']);
    await noWrites(async () => assert.equal((await host.call(input(cfg.binding.operationId))).code, 'CONTINUITY_LOST'));
    await witnessPool.query('UPDATE once_continuity.checkpoints SET revision=$2,generation=$3 WHERE authority_id=$1', [cfg.authorityId, cp.revision, cp.generation]);
    const unavailable = await connect({ ...cfg, shared: { ...cfg.shared, executionUrl: 'postgresql://unused:unused@127.0.0.1:1/missing' } });
    await noWrites(async () => assert.equal((await unavailable.call(input(cfg.binding.operationId))).code, 'STATE_UNAVAILABLE'));
    const unavailableWitness = await connect({ ...cfg, shared: { ...cfg.shared, witnessUrl: 'postgresql://unused:unused@127.0.0.1:1/missing' } });
    await noWrites(async () => assert.equal((await unavailableWitness.call(input(cfg.binding.operationId))).code, 'CONTINUITY_UNAVAILABLE'));
    assert.equal((await host.call(input(cfg.binding.operationId))).status, 'CONFIRMED'); oneEffect(cfg.binding.operationId);
  });
  await check('H10', 'missing/corrupt intent never recreates admission; runtime cannot provision/delete', async () => {
    const cfg = await provision(); const host = await connect(cfg);
    await noWrites(async () => {
      for (const sql of ['DELETE FROM once_execution.host_intents', 'UPDATE once_execution.host_intents SET operation_id=operation_id', "INSERT INTO once_execution.host_intents VALUES('x','x','x','x','x')", 'UPDATE once_execution.operations SET fingerprint=fingerprint', 'TRUNCATE once_execution.operations', 'DROP SCHEMA once_execution CASCADE']) await assert.rejects(runtimePool.query(sql), { code: '42501' });
      await assert.rejects(admitPostgresIntent({ ...cfg, pool: runtimePool }, { scope: 'host-scope', intentKey: 'forged-admission', effect }), { code: 'STATE_UNAVAILABLE' });
      await pool.query("UPDATE once_execution.host_intents SET operation_id='corrupt' WHERE authority_id=$1", [cfg.authorityId]);
      assert.equal((await host.call(input(cfg.binding.operationId))).code, 'CONTINUITY_LOST');
      await pool.query('DELETE FROM once_execution.host_intents WHERE authority_id=$1', [cfg.authorityId]);
      assert.equal((await host.call(input(cfg.binding.operationId))).code, 'CONTINUITY_LOST');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM once_execution.host_intents WHERE authority_id=$1', [cfg.authorityId])).rows[0].n, 0);
    });
  });
  await check('H11', 'changed trusted admission conflicts; ambiguous/missing scope is denied', async () => {
    const cfg = await provision(); const before = counts();
    await assert.rejects(admitPostgresIntent({ ...cfg, pool: admissionPool }, { scope: 'host-scope', intentKey: cfg.key, effect: { ...effect, args: { ...effect.args, providerArgs: { ...order, quantity: 3 } } } }), { code: 'CONFLICT' });
    await assert.rejects(cfg.runtime.resolveIntent('', cfg.key), { code: 'INTENT_REQUIRED' });
    await assert.rejects(cfg.runtime.resolveIntent('scope', 'ambiguous\ud800'), { code: 'INTENT_REQUIRED' });
    await assert.rejects(admitPostgresIntent({ ...cfg, pool: admissionPool }, null), { code: 'INTENT_REQUIRED' });
    await assert.rejects(cfg.runtime.resolveIntent('other-scope', cfg.key), { code: 'INTENT_REQUIRED' });
    assert.deepEqual(counts(), before);
  });
  await check('H12', 'local replacement SQLite cannot change the independently held execution authority', async () => {
    const cfg = await provision(); let host = await connect(cfg); assert.equal((await host.call(input(cfg.binding.operationId))).status, 'CONFIRMED'); await stop(host);
    // The protected configuration does not consult or initialize this untrusted
    // worker-local checkpoint. Its replacement supplies no execution permission.
    const file = path.join(root, 'replaced-worker-checkpoint.sqlite');
    const db = new DatabaseSync(file); db.exec('CREATE TABLE local_operations(id TEXT PRIMARY KEY)'); db.close();
    host = await connect(cfg); await noWrites(async () => assert.equal((await host.call(input(cfg.binding.operationId))).status, 'CONFIRMED')); oneEffect(cfg.binding.operationId);
  });
});

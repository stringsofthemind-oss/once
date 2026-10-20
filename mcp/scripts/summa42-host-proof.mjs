import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { EMPTY_HOST_AUTHORITY_DIGEST, admitPostgresIntent, createPostgresContinuityWitness } from '@once-agent/sdk';
import { startOrderProvider } from '../test/fixtures/order-provider.mjs';

const binary = process.env.ONCE_SUMMA42_BINARY;
assert.ok(binary && process.env.ONCE_TEST_POSTGRES && process.env.ONCE_TEST_WITNESS, 'Supply the compiled actual Summa42 fixture and two disposable PostgreSQL clusters');
const parent = path.resolve(process.argv[2] ?? 'summa42-host-runs'); mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, 'run-')), home = path.join(root, 'actual-summa42'); mkdirSync(home);
const events = [], hosts = [];
const log = (event, data = {}) => events.push({ sequence: events.length + 1, at: new Date().toISOString(), event, ...JSON.parse(JSON.stringify(data)) });
const bridgeToken = randomUUID();
let bridgeUrl, source, binding, holdUnknown, releaseUnknown;
const firstUnknown = new Promise(resolve => { releaseUnknown = resolve; });
function startGo(stage) {
  const child = spawn(binary, [], { env: { ...process.env, ONCE_FIXTURE_ONLY: 'disposable-summa42', ONCE_SUMMA42_FIXTURE: home, ONCE_SUMMA42_STAGE: stage, ONCE_BRIDGE_URL: bridgeUrl ?? '', ONCE_BRIDGE_TOKEN: bridgeToken }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error(`Summa42 ${stage} timed out`)); }, 20000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer); if (signal) { resolve({ code, signal }); return; }
      if (code !== 0) { reject(Error(`Summa42 ${stage} failed: ${stderr}`)); return; }
      const result = JSON.parse(stdout.trim().split('\n').at(-1)); log('actual-summa42-stage', { stage, result }); resolve(result);
    });
  });
  return { child, done };
}
const sqliteRows = () => {
  const db = new DatabaseSync(path.join(home, 'summa42.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT operation_id,attempt_id,effect_slot_id,state,provider_reference,intent_fingerprint FROM external_operations').all().map(x => ({ ...x })); } finally { db.close(); }
};
const attemptCount = () => {
  const db = new DatabaseSync(path.join(home, 'summa42.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT count(*) AS n FROM attempts').get().n; } finally { db.close(); }
};
const admins = [process.env.ONCE_TEST_POSTGRES, process.env.ONCE_TEST_WITNESS].map(connectionString => new pg.Pool({ connectionString }));
const names = [0, 1].map(() => `once_summa_${randomUUID().replaceAll('-', '')}`);
for (let i = 0; i < 2; i++) await admins[i].query(`CREATE DATABASE ${names[i]}`);
const urls = [process.env.ONCE_TEST_POSTGRES, process.env.ONCE_TEST_WITNESS].map((base, i) => { const u = new URL(base); u.pathname = `/${names[i]}`; return u.href; });
const [pool, witnessPool] = urls.map(connectionString => new pg.Pool({ connectionString }));
for (const p of [...admins, pool, witnessPool]) p.on('error', () => {});
const repositorySql = fileURLToPath(new URL('../../sdk/typescript/sql/', import.meta.url));
const sqlRoot = process.env.ONCE_SQL_ROOT ?? (existsSync(repositorySql) ? repositorySql : fileURLToPath(new URL('../sql/', import.meta.url)));
await pool.query(readFileSync(path.join(sqlRoot, 'execution-authority-v1.sql'), 'utf8'));
await pool.query(readFileSync(path.join(sqlRoot, 'execution-host-intents-v2.sql'), 'utf8'));
await witnessPool.query(readFileSync(path.join(sqlRoot, 'continuity-witness-v1.sql'), 'utf8'));
await witnessPool.query(readFileSync(path.join(sqlRoot, 'continuity-witness-v2.sql'), 'utf8'));
const authorityId = randomUUID(), witnessId = randomUUID();
await pool.query("INSERT INTO once_execution.authorities VALUES($1,2,'g1',1,0,$2)", [authorityId, EMPTY_HOST_AUTHORITY_DIGEST]);
await witnessPool.query('INSERT INTO once_continuity.metadata VALUES(true,$1,2)', [witnessId]);
await witnessPool.query("INSERT INTO once_continuity.checkpoints VALUES($1,'g1',1,0,$2)", [authorityId, EMPTY_HOST_AUTHORITY_DIGEST]);
const witness = createPostgresContinuityWitness({ pool: witnessPool, expectedWitnessId: witnessId, expectedSchemaVersion: 2 });
const provider = await startOrderProvider(path.join(root, 'provider.jsonl'), { onCommit: receipt => log('provider-commit-fsynced', { receipt }), onAckDropped: receipt => log('provider-ack-dropped', { operationId: receipt.operationId }) });
async function host(lookupOnly) {
  const config = { providerUrl: provider.url, token: provider.token, accountId: 'account-A', resourceId: 'orders-local', trustedIntentKey: binding.intentKey, leaseMs: 2000, lookupOnly,
    shared: { executionUrl: urls[0], witnessUrl: urls[1], authorityId, witnessId, generation: 'g1', epoch: '1', scope: binding.scope } };
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../test/fixtures/order-host.mjs', import.meta.url))], env: { ...process.env, ONCE_TEST_HOST: JSON.stringify(config) }, stderr: 'pipe' });
  const client = new Client({ name: `actual-summa42-${lookupOnly ? 'read-only-recovery' : 'dispatch'}`, version: '1' });
  let diagnostics = ''; transport.stderr.on('data', x => { diagnostics += x; });
  try { await client.connect(transport); } catch { throw Error(`MCP host startup failed: ${diagnostics}`); }
  hosts.push(client); return client;
}
let dispatchHost, lookupHost;
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${bridgeToken}`) { res.writeHead(401).end(); return; }
  if (req.method !== 'POST' || !['/dispatch', '/lookup'].includes(req.url)) { res.writeHead(404).end(); return; }
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    const valid = data.OperationID === source.operationId && data.TaskID === source.taskId && data.EffectSlotID === source.effectSlotId &&
      data.IntentFingerprint === source.intentFingerprint && data.IntentRevision === 1 &&
      Buffer.from(data.CanonicalIntent, 'base64').toString() === source.canonical;
    if (!valid) { log('untrusted-context-denied'); res.writeHead(409).end(JSON.stringify({ status: 'CONFLICT' })); return; }
    log('actual-provider-interface', { mode: req.url, operationId: data.OperationID, effectSlotId: data.EffectSlotID });
    const response = await (req.url === '/dispatch' ? dispatchHost : lookupHost).callTool({ name: 'once_create_order', arguments: { operationId: binding.operationId, args: { sku: 'SKU-1', quantity: 2, destinationId: 'address-1' } } });
    const outcome = JSON.parse(response.content[0].text); log('bridge-outcome', { mode: req.url, outcome });
    if (holdUnknown && req.url === '/dispatch' && outcome.code === 'UNKNOWN') { releaseUnknown(); return; } // no response: parent kills the actual Go worker here
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(outcome));
  } catch { res.writeHead(503).end(JSON.stringify({ status: 'UNKNOWN' })); }
});
let success = false;
try {
  source = await startGo('init').done;
  const db = new DatabaseSync(path.join(home, 'summa42.sqlite'), { readOnly: true });
  const slot = db.prepare('SELECT * FROM effect_slots WHERE effect_slot_id=?').get(source.effectSlotId);
  const op = sqliteRows()[0]; db.close();
  source.intentFingerprint = op.intent_fingerprint;
  source.canonical = slot.canonical_intent_json;
  assert.equal(typeof source.canonical, 'string');
  const effect = { tool: 'once_create_order', args: { contract: 'once-registered-order-v1', action: 'once_create_order', authority: { provider: 'disposable-orders', accountId: 'account-A', environment: 'local-test' }, resourceId: 'orders-local', providerArgs: { sku: 'SKU-1', quantity: 2, destinationId: 'address-1' } } };
  binding = await admitPostgresIntent({ pool, witness, authorityId, expectedGeneration: 'g1', expectedEpoch: '1' }, { scope: 'trusted-summa42-collective', intentKey: `${source.taskId}/${source.effectSlotId}`, effect });
  log('operator-admitted-actual-summa42-slot', { source, binding });
  dispatchHost = await host(false); lookupHost = await host(true);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); bridgeUrl = `http://127.0.0.1:${server.address().port}`;
  provider.modes.set(binding.operationId, 'lost-ack'); provider.observations.set(binding.operationId, { status: 'UNKNOWN' });
  holdUnknown = true;
  const worker = startGo('dispatch');
  await Promise.race([firstUnknown, worker.done.then(() => { throw Error('Go worker exited before acknowledgement-loss kill barrier'); })]);
  assert.equal(provider.records().length, 1);
  assert.equal(sqliteRows()[0].state, 'DISPATCHED');
  worker.child.kill('SIGKILL'); const killed = await worker.done; assert.equal(killed.signal, 'SIGKILL');
  log('actual-summa42-worker-killed', { pid: worker.child.pid, ledger: sqliteRows() }); holdUnknown = false;
  const blocked = [];
  for (let i = 0; i < 3; i++) {
    const result = await startGo('recover').done; blocked.push(result);
    assert.equal(result.state, 'OUTCOME_UNKNOWN'); assert.equal(result.reservation, 'UNRESOLVED');
    assert.equal(result.hostGate, 'BLOCKED_UNRESOLVED'); assert.equal(attemptCount(), 1);
    assert.equal(result.operationId, source.operationId); assert.equal(result.effectSlotId, source.effectSlotId);
    assert.equal(provider.records().length, 1); assert.equal(provider.counters.posts, 1);
  }
  provider.observations.delete(binding.operationId);
  const recovered = await startGo('recover').done;
  assert.equal(recovered.state, 'CONFIRMED_EFFECT'); assert.equal(recovered.providerReference, provider.records()[0].providerReference);
  const lookups = provider.counters.lookups;
  const replay = await startGo('recover').done;
  assert.equal(replay.state, 'CONFIRMED_EFFECT'); assert.equal(replay.providerReference, recovered.providerReference);
  assert.equal(provider.counters.lookups, lookups); assert.equal(provider.counters.posts, 1);
  assert.equal(new Set(blocked.map(x => x.pid)).size, 3);
  for (const result of blocked) assert.equal(result.attemptId, source.attemptId);
  assert.notEqual(recovered.attemptId, source.attemptId); assert.equal(attemptCount(), 3);
  success = true;
} finally {
  for (const client of hosts) await client.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await provider.close();
  writeFileSync(path.join(root, 'events.jsonl'), events.map(x => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(path.join(root, 'results.json'), JSON.stringify({ success, summa42Revision: process.env.ONCE_SUMMA42_REVISION ?? 'unrecorded',
    binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), actualServices: ['operations.Service', 'execution.Service', 'resources.Service', 'approvals.Service', 'sqlite.Store'],
    scope: 'actual pinned Summa42 services with reference host gate before replacement Attempt creation; no Box/LLM/global-scheduler conformance claim',
    gateAppliedBeforeReplacementAttempt: true, finalAttemptCount: attemptCount(),
    source, binding, providerCounters: provider.counters, providerEffects: provider.records().length, finalSumma42Ledger: sqliteRows() }, null, 2));
  for (const p of [pool, witnessPool]) await p.end();
  for (let i = 0; i < 2; i++) { await admins[i].query(`DROP DATABASE ${names[i]}`); await admins[i].end(); }
  console.log(`Actual Summa42 service evidence: ${root}`);
}

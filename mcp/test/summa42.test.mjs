import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { watch, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createLocalProtectionSession } from '@once-agent/sdk/connect';
import { protectToolCall } from '@once-agent/sdk';
import { startOrderProvider } from './fixtures/order-provider.mjs';

const hostPath = fileURLToPath(new URL('./fixtures/order-host.mjs', import.meta.url));
const root = process.env.ONCE_SUMMA42_RESULTS ?? mkdtempSync(path.join(tmpdir(), 'once-summa42-'));
mkdirSync(root, { recursive: true });
const report = { schema: 'once-summa42-evidence-v1', startedAt: new Date().toISOString(), runtime: process.version,
  platform: process.platform, arch: process.arch, tests: [], scope: 'controlled loopback provider; same-machine SQLite; no Summa42 runtime integration' };
const events = [];
function record(event, data = {}) {
  events.push({ sequence: events.length + 1, at: new Date().toISOString(), event, ...data });
}
const order = { sku: 'SKU-1', quantity: 2, destinationId: 'address-1' };
const input = (operationId, args = order) => ({ operationId, args });
const output = response => {
  const parsed = JSON.parse(response.content[0].text);
  assert.deepEqual(response.structuredContent, parsed);
  return parsed;
};
const ledgerRows = statePath => {
  const db = new DatabaseSync(statePath, { readOnly: true });
  try { return db.prepare('SELECT id,fingerprint,state,result_json,lease_until FROM local_operations ORDER BY id').all().map(x => ({ ...x })); }
  finally { db.close(); }
};
function waitForFile(filename) {
  return new Promise((resolve, reject) => {
    let watcher;
    const timer = setTimeout(() => { watcher?.close(); reject(Error('acknowledgement-loss barrier timed out')); }, 15000);
    const check = () => {
      if (!existsSync(filename)) return;
      try {
        const data = JSON.parse(readFileSync(filename, 'utf8'));
        clearTimeout(timer); watcher?.close(); resolve(data);
      } catch { /* A write event can precede completion; the next event retries. */ }
    };
    watcher = watch(path.dirname(filename), check); check();
  });
}
async function fixture(t, name) {
  const dir = path.join(root, name); mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, 'once.sqlite');
  const initial = createLocalProtectionSession(statePath); await initial.databaseForCall(); initial.close();
  const journalPath = path.join(dir, 'provider.jsonl');
  const provider = await startOrderProvider(journalPath, {
    onCommit: receipt => record('provider-commit-fsynced', { test: name, receipt }),
    onAckDropped: receipt => record('provider-acknowledgement-dropped', { test: name, operationId: receipt.operationId }),
  });
  const hosts = new Set();
  let attemptNumber = 0;
  const connect = async (overrides = {}) => {
    const attemptId = `attempt-${++attemptNumber}-${randomUUID()}`, sessionId = randomUUID();
    const config = { providerUrl: provider.url, token: provider.token, statePath, accountId: 'account-A', resourceId: 'orders-local', ...overrides };
    const transport = new StdioClientTransport({ command: process.execPath, args: [hostPath], env: { ...process.env, ONCE_TEST_HOST: JSON.stringify(config) }, stderr: 'pipe' });
    let diagnostics = '';
    transport.stderr.on('data', chunk => { diagnostics += chunk; });
    const send = transport.send.bind(transport);
    transport.send = async message => {
      if (message.method === 'tools/call') record('mcp-request', { test: name, attemptId, sessionId, pid: transport.pid, requestId: message.id, operationId: message.params.arguments.operationId });
      return send(message);
    };
    const client = new Client({ name: attemptId, version: '1' });
    const handle = { client, transport, attemptId, sessionId, call: async x => {
      const result = output(await client.callTool({ name: 'once_create_order', arguments: x }, { timeout: 15000 }));
      record('mcp-outcome', { test: name, attemptId, sessionId, operationId: x.operationId, outcome: result });
      return result;
    } };
    hosts.add(handle);
    try {
      await client.connect(transport);
      // Real transport requests advance the JSON-RPC counter between attempts.
      for (let i = 0; i < attemptNumber; i++) await client.ping();
      record('worker-started', { test: name, attemptId, sessionId, pid: transport.pid });
      return handle;
    } catch (error) {
      record('worker-startup-rejected', { test: name, attemptId, sessionId, stateFile: path.basename(config.statePath), diagnostic: diagnostics });
      await client.close(); hosts.delete(handle); throw new Error(`Worker startup failed: ${diagnostics}`, { cause: error });
    }
  };
  const stop = async host => { await host.client.close(); hosts.delete(host); };
  const counts = () => ({ effects: provider.records().length, posts: provider.counters.posts });
  const noWrites = async fn => { const before = counts(); await fn(); assert.deepEqual(counts(), before); };
  t.after(async () => {
    for (const host of hosts) await stop(host);
    await provider.close();
    writeFileSync(path.join(dir, 'provider-counters.json'), JSON.stringify(provider.counters, null, 2));
    record('final-provider-count', { test: name, ...counts() });
  });
  return { dir, statePath, provider, connect, stop, counts, noWrites };
}

test('Summa42 #35 bounded external-effect evidence', { timeout: 180000 }, async t => {
  t.after(() => {
    report.finishedAt = new Date().toISOString();
    report.passed = report.tests.filter(x => x.status === 'PASS').length;
    report.failed = report.tests.filter(x => x.status === 'FAIL').length;
    report.success = report.failed === 0 && report.tests.length === 8;
    writeFileSync(path.join(root, 'events.jsonl'), events.map(x => JSON.stringify(x)).join('\n') + '\n');
    report.eventsSha256 = createHash('sha256').update(readFileSync(path.join(root, 'events.jsonl'))).digest('hex');
    writeFileSync(path.join(root, 'results.json'), JSON.stringify(report, null, 2));
    console.log(`Evidence: ${root}`);
  });
  const check = async (id, title, criteria, fn) => t.test(`${id}: ${title}`, async st => {
    const entry = { id, title, criteria, status: 'RUNNING' }; report.tests.push(entry);
    try { await fn(st); entry.status = 'PASS'; }
    catch (error) { entry.status = 'FAIL'; entry.error = { name: error.name, message: error.message }; throw error; }
  });

  await check('T01', 'raw duplicate control commits twice', ['AC1', 'AC4'], async st => {
    const f = await fixture(st, 'T01');
    const effect = { contract: 'once-registered-order-v1', action: 'once_create_order', authority: { provider: 'disposable-orders', accountId: 'account-A', environment: 'local-test' }, resourceId: 'orders-local', providerArgs: order };
    f.provider.modes.set('raw-control', 'lost-ack');
    for (let i = 0; i < 2; i++) await assert.rejects(fetch(`${f.provider.url}/orders`, {
      method: 'POST', headers: { Authorization: `Bearer ${f.provider.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: 'raw-control', effect }), signal: AbortSignal.timeout(5000),
    }));
    assert.deepEqual(f.counts(), { effects: 2, posts: 2 });
  });

  await check('T02', 'commit, drop ack, kill, replacement, UNKNOWN, reconcile and replay', ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'], async st => {
    const f = await fixture(st, 'T02');
    const operationId = 'task-35:order:1';
    const intentPath = path.join(f.dir, 'intent.json');
    writeFileSync(intentPath, JSON.stringify({ operationId, args: order, statePath: f.statePath }), { flush: true });
    const persisted = () => { const { operationId, args } = JSON.parse(readFileSync(intentPath)); return { operationId, args }; };
    f.provider.modes.set(operationId, 'lost-ack');
    f.provider.observations.set(operationId, { status: 'UNKNOWN' });
    const marker = path.join(f.dir, 'ack-loss-barrier.json');
    const first = await f.connect({ afterAckLossMarker: marker });
    const barrier = waitForFile(marker);
    const pending = first.call(persisted()).then(() => { throw Error('crashed call unexpectedly returned'); }, () => undefined);
    const observed = await barrier;
    assert.equal(observed.pid, first.transport.pid); assert.equal(observed.operationId, operationId);
    assert.deepEqual(f.counts(), { effects: 1, posts: 1 });
    assert.equal(ledgerRows(f.statePath)[0].state, 'CLAIMED');
    record('worker-observed-ack-loss-before-once-return', { test: 'T02', ...observed });
    process.kill(first.transport.pid, 'SIGKILL'); await pending; await f.stop(first);
    record('worker-killed-call-closed', { test: 'T02', pid: observed.pid });
    const replacement = await f.connect();
    assert.notEqual(first.attemptId, replacement.attemptId); assert.notEqual(first.sessionId, replacement.sessionId);
    await f.noWrites(async () => assert.equal((await replacement.call(persisted())).code, 'IN_FLIGHT'));
    const claim = ledgerRows(f.statePath)[0];
    record('abandoned-claim', { test: 'T02', row: claim });
    // Wait for the actual 30s lease. No SQL clock/state edits and no redispatch.
    await delay(Math.max(0, claim.lease_until - Date.now() + 20));
    await f.noWrites(async () => {
      for (let i = 0; i < 3; i++) {
        const result = await replacement.call(persisted());
        assert.equal(result.code, 'UNKNOWN'); assert.equal(result.retryAllowed, false);
      }
      await f.stop(replacement);
      const replanned = await f.connect();
      assert.equal((await replanned.call(persisted())).code, 'UNKNOWN');
      assert.equal(ledgerRows(f.statePath)[0].state, 'UNKNOWN');
      const exactReceipt = f.provider.records()[0];
      // Independent fsynced journal is asserted against the GET reconciliation result.
      f.provider.observations.delete(operationId);
      const truth = await (await fetch(`${f.provider.url}/orders/${encodeURIComponent(operationId)}`, { headers: { Authorization: `Bearer ${f.provider.token}` } })).json();
      assert.equal(truth.status, 'CONFIRMED'); assert.deepEqual(truth.receipt, exactReceipt);
      record('independent-provider-get', { test: 'T02', truth });
      const before = f.provider.counters.lookups;
      let recovered;
      for (let i = 0; i < 5; i++) {
        recovered = await replanned.call(persisted());
        if (recovered.status === 'CONFIRMED') break;
        // A conservative lookup failure is not a new execution right. Permit
        // bounded read-only re-observation, always with the original identity.
        assert.equal(recovered.code, 'UNKNOWN'); assert.equal(recovered.retryAllowed, false);
      }
      assert.equal(recovered.status, 'CONFIRMED'); assert.deepEqual(recovered.result, exactReceipt);
      assert.ok(f.provider.counters.lookups > before && f.provider.counters.lookups <= before + 5);
      assert.equal(ledgerRows(f.statePath)[0].state, 'CONFIRMED');
      await f.stop(replanned);
      f.provider.observations.set(operationId, { status: 'UNKNOWN' });
      const final = await f.connect();
      const reads = f.provider.counters.lookups;
      assert.deepEqual(await final.call(persisted()), recovered);
      assert.equal(f.provider.counters.lookups, reads);
      record('final-ledger', { test: 'T02', rows: ledgerRows(f.statePath) });
    });
    const requests = events.filter(x => x.test === 'T02' && x.event === 'mcp-request');
    assert.notEqual(requests[0].requestId, requests[1].requestId);
    assert.deepEqual([...new Set(requests.map(x => x.operationId))], [operationId]);
  });

  await check('T03', 'effect drift is CONFLICT before provider write', ['AC2', 'AC5'], async st => {
    const f = await fixture(st, 'T03'); const host = await f.connect();
    f.provider.modes.set('drift', 'lost-ack'); f.provider.observations.set('drift', { status: 'UNKNOWN' });
    assert.equal((await host.call(input('drift'))).code, 'UNKNOWN');
    await f.noWrites(async () => {
      for (const args of [{ ...order, sku: 'SKU-2' }, { ...order, quantity: 3 }, { ...order, destinationId: 'address-2' }]) assert.equal((await host.call(input('drift', args))).code, 'CONFLICT');
      for (const overrides of [{ resourceId: 'other-resource' }, { name: 'once_other_order' }]) {
        const changed = await f.connect(overrides);
        const response = overrides.name ? output(await changed.client.callTool({ name: overrides.name, arguments: input('drift') })) : await changed.call(input('drift'));
        assert.equal(response.code, 'CONFLICT'); await f.stop(changed);
      }
      f.provider.setAccount('account-B'); const other = await f.connect({ accountId: 'account-B' });
      assert.equal((await other.call(input('drift'))).code, 'CONFLICT');
      f.provider.setAccount('account-A');
    });
  });

  await check('T04', 'unavailable, absent, malformed and mismatched truth remain UNKNOWN', ['AC2', 'AC3'], async st => {
    const f = await fixture(st, 'T04'); const host = await f.connect();
    f.provider.modes.set('truth', 'lost-ack'); assert.equal((await host.call(input('truth'))).code, 'UNKNOWN');
    const receipt = f.provider.records()[0];
    const positive = { status: 'CONFIRMED', authoritative: true, complete: true, observedAt: Date.now(), receipt };
    await f.noWrites(async () => {
      // A thrown lookup is covered by the SDK directly below; the MCP path tests bad envelopes.
      const variants = [new Error('lookup unavailable'), null, { status: 'UNKNOWN' }, { status: 'NOT_FOUND' }, { status: 'ABSENT', authoritative: true },
        { status: 'CONFIRMED' }, { ...positive, authoritative: false }, { ...positive, complete: false },
        { ...positive, observedAt: Date.now() - 60000 }, { ...positive, observedAt: Date.now() + 60000 },
        { ...positive, receipt: { ...receipt, operationId: 'substituted-id' } },
        { ...positive, receipt: { ...receipt, effect: { ...receipt.effect, providerArgs: { ...order, quantity: 3 } } } }];
      for (const observation of variants) {
        f.provider.observations.set('truth', observation);
        const result = await host.call(input('truth')); assert.equal(result.code, 'UNKNOWN'); assert.equal(result.retryAllowed, false);
      }
      await assert.rejects(protectToolCall({ operationId: 'truth', statePath: path.join(f.dir, 'sdk.sqlite'), effect: { tool: 'sdk:truth', args: order }, execute: async () => { throw Error('transport unavailable'); } }), { code: 'UNKNOWN' });
      await assert.rejects(protectToolCall({ operationId: 'truth', statePath: path.join(f.dir, 'sdk.sqlite'), effect: { tool: 'sdk:truth', args: order }, execute: async () => { throw Error('must not dispatch'); }, reconcile: () => { throw Error('provider lookup unavailable'); } }), { code: 'UNKNOWN' });
    });
    await f.stop(host);
    // Actually stop the provider, including authority GETs; fail closed at host admission.
    await f.provider.close();
    await assert.rejects(f.connect());
  });

  await check('T05', 'missing, corrupt, empty and schema-lost state reject replacement', ['AC2', 'AC3', 'AC5'], async st => {
    const f = await fixture(st, 'T05'); let host = await f.connect();
    f.provider.modes.set('state-loss', 'lost-ack'); f.provider.observations.set('state-loss', { status: 'UNKNOWN' });
    assert.equal((await host.call(input('state-loss'))).code, 'UNKNOWN');
    await f.stop(host);
    await f.noWrites(async () => {
      const original = path.join(f.dir, 'original.sqlite'); renameSync(f.statePath, original);
      await assert.rejects(f.connect()); assert.equal(existsSync(f.statePath), false);
      renameSync(original, f.statePath);
      for (const [name, data] of [['corrupt.sqlite', 'not sqlite'], ['empty.sqlite', '']]) {
        const statePath = path.join(f.dir, name); writeFileSync(statePath, data);
        await assert.rejects(f.connect({ statePath }));
      }
      host = await f.connect();
      const db = new DatabaseSync(f.statePath); db.exec('DROP TABLE local_operations'); db.close();
      assert.equal((await host.call(input('state-loss'))).code, 'STATE_UNAVAILABLE');
      assert.equal((await host.call(input('new-after-state-loss'))).code, 'STATE_UNAVAILABLE');
      await f.stop(host); await assert.rejects(f.connect());
      const inspect = new DatabaseSync(f.statePath, { readOnly: true });
      assert.equal(inspect.prepare("SELECT name FROM sqlite_schema WHERE name='local_operations'").get(), undefined); inspect.close();
    });
  });

  await check('T06', 'identity injection rejected; fresh IDs are an explicit safety limit', ['AC3', 'AC5'], async st => {
    const f = await fixture(st, 'T06'); const host = await f.connect();
    f.provider.modes.set('original', 'lost-ack'); f.provider.observations.set('original', { status: 'UNKNOWN' });
    assert.equal((await host.call(input('original'))).code, 'UNKNOWN');
    await f.noWrites(async () => {
      for (const x of [input(''), { ...input('original'), attemptId: 'replacement' }, { operationId: 'original', args: { ...order, operationId: 'substitute' } }]) {
        assert.equal((await host.client.callTool({ name: 'once_create_order', arguments: x })).isError, true);
      }
      assert.equal((await host.call(input('original'))).code, 'UNKNOWN');
    });
    // This MUST succeed: no SDK can infer that an arbitrary new ID is the same intent.
    assert.equal((await host.call(input('new-id-for-same-payload'))).status, 'CONFIRMED');
    assert.deepEqual(f.counts(), { effects: 2, posts: 2 });
    record('demonstrated-limit-new-identity', { test: 'T06', originalOutcome: 'UNKNOWN', samePayloadNewIdOutcome: 'CONFIRMED', effects: 2,
      requiredControl: 'host must retain/admit the canonical operation ID across planner iterations' });
  });

  await check('T07', 'valid empty replacement ledger after restart is an explicit safety limit', ['AC3', 'AC5'], async st => {
    const f = await fixture(st, 'T07'); const host = await f.connect();
    f.provider.modes.set('replaced-ledger', 'lost-ack'); f.provider.observations.set('replaced-ledger', { status: 'UNKNOWN' });
    assert.equal((await host.call(input('replaced-ledger'))).code, 'UNKNOWN'); await f.stop(host);
    renameSync(f.statePath, path.join(f.dir, 'original.sqlite'));
    // Deliberate operator misuse, confined to disposable state: schema-valid new authority.
    const replacement = createLocalProtectionSession(f.statePath); await replacement.databaseForCall(); replacement.close();
    f.provider.modes.delete('replaced-ledger');
    const restarted = await f.connect();
    assert.equal((await restarted.call(input('replaced-ledger'))).status, 'CONFIRMED');
    assert.deepEqual(f.counts(), { effects: 2, posts: 2 });
    record('demonstrated-limit-valid-replacement-ledger', { test: 'T07', effects: 2, requiredControl: 'restore original authority; independent continuity witness needed to reject a valid replacement across process lifetimes' });
  });

  await check('T08', 'confirmed receipt survives replacement attempt without lookup or execution', ['AC3', 'AC5'], async st => {
    const f = await fixture(st, 'T08'); const first = await f.connect();
    const confirmed = await first.call(input('confirmed')); assert.equal(confirmed.status, 'CONFIRMED'); await f.stop(first);
    await f.noWrites(async () => {
      f.provider.observations.set('confirmed', { status: 'UNKNOWN' }); const second = await f.connect();
      const reads = f.provider.counters.lookups;
      assert.deepEqual(await second.call(input('confirmed')), confirmed);
      assert.equal(f.provider.counters.lookups, reads);
      assert.equal((await second.call(input('confirmed', { ...order, quantity: 3 }))).code, 'CONFLICT');
    });
  });
});

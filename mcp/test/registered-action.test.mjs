import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import { createLocalProtectionSession } from '@once-agent/sdk/connect';
import { registerProtectedOrderAction } from '@once-agent/mcp/registered-action';
import { startOrderProvider } from './fixtures/order-provider.mjs';

const hostPath = fileURLToPath(new URL('./fixtures/order-host.mjs', import.meta.url));
const order = { sku: 'SKU-1', quantity: 2, destinationId: 'address-1' };
const input = (operationId, args = order) => ({ operationId, args });
const output = response => {
  const parsed = JSON.parse(response.content[0].text);
  assert.deepEqual(response.structuredContent, parsed, 'text and structured outcomes agree');
  return parsed;
};
async function waitUntil(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await delay(10); }
  throw Error('fixture did not reach expected provider effect');
}

test('registered action across actual stdio MCP and authenticated independent provider', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'once-registered-action-'));
  const statePath = path.join(dir, 'ledger.sqlite');
  // Explicit fixture provisioning. Registration never creates a missing ledger.
  const initial = createLocalProtectionSession(statePath); await initial.databaseForCall(); initial.close();
  const provider = await startOrderProvider(path.join(dir, 'provider-effects.jsonl'));
  const hosts = new Set();
  const proof = [];
  async function connect(overrides = {}) {
    const config = { providerUrl: provider.url, token: provider.token, statePath, accountId: 'account-A', resourceId: 'orders-local', ...overrides };
    const transport = new StdioClientTransport({ command: process.execPath, args: [hostPath], env: { ...process.env, ONCE_TEST_HOST: JSON.stringify(config) }, stderr: 'pipe' });
    let diagnostics = '';
    transport.stderr.on('data', data => { diagnostics += data; });
    const client = new Client({ name: 'registered-action-test-agent', version: '1' });
    const handle = { client, transport, call: (x, name = config.name ?? 'once_create_order') => client.callTool({ name, arguments: x }) };
    hosts.add(handle);
    try { await client.connect(transport); } catch (error) { throw new Error(`Host connection failed: ${diagnostics}`, { cause: error }); }
    return handle;
  }
  async function stop(host) { await host.client.close(); hosts.delete(host); }
  t.after(async () => {
    for (const host of hosts) await host.client.close();
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let host = await connect();
  const verifyNoWrites = async fn => {
    const effects = provider.records().length, posts = provider.counters.posts;
    await fn();
    assert.equal(provider.records().length, effects);
    assert.equal(provider.counters.posts, posts);
  };
  const check = async (name, fn) => t.test(name, async () => {
    await fn();
    proof.push({ scenario: name, providerEffects: provider.records().length, writeRequests: provider.counters.posts, lookupRequests: provider.counters.lookups });
  });

  let first;
  await check('first execution, strict catalog and immutable complete provider effect', async () => {
    const tools = (await host.client.listTools()).tools;
    assert.deepEqual(tools.map(x => x.name), ['once_create_order']);
    assert.equal(tools[0].inputSchema.additionalProperties, false);
    assert.equal(tools[0].inputSchema.properties.args.additionalProperties, false);
    first = output(await host.call(input('intent-1')));
    assert.equal(first.status, 'CONFIRMED');
    assert.equal(provider.records().length, 1);
    assert.deepEqual(provider.records()[0].effect.providerArgs, order);
    assert.equal('operationId' in provider.records()[0].effect.providerArgs, false);
    assert.deepEqual(provider.records()[0], first.result);
  });
  await check('exact replay adds no provider effect or lookup', async () => verifyNoWrites(async () => {
    const reads = provider.counters.lookups;
    assert.deepEqual(output(await host.call(input('intent-1'))), first);
    assert.equal(provider.counters.lookups, reads);
  }));
  await check('changed input, resource and tool conflict before dispatch', async () => verifyNoWrites(async () => {
    for (const args of [{ ...order, sku: 'SKU-2' }, { ...order, quantity: 3 }, { ...order, destinationId: 'address-2' }]) {
      assert.equal(output(await host.call(input('intent-1', args))).code, 'CONFLICT');
    }
    const resource = await connect({ resourceId: 'other-resource' });
    assert.equal(output(await resource.call(input('intent-1'))).code, 'CONFLICT'); await stop(resource);
    const renamed = await connect({ name: 'once_other_order' });
    assert.equal(output(await renamed.call(input('intent-1'))).code, 'CONFLICT'); await stop(renamed);
  }));
  await check('identical payload and genuinely new operationId dispatch separately', async () => {
    assert.equal(output(await host.call(input('intent-2'))).status, 'CONFIRMED');
    assert.equal(provider.records().length, 2);
  });
  await check('concurrent processes share one claim and one provider effect', async () => {
    const other = await connect();
    provider.modes.set('concurrent', 'hold');
    const count = provider.records().length;
    const pending = host.call(input('concurrent'));
    await waitUntil(() => provider.records().length === count + 1);
    assert.equal(output(await other.call(input('concurrent'))).code, 'IN_FLIGHT');
    provider.release();
    const confirmed = output(await pending);
    assert.deepEqual(output(await other.call(input('concurrent'))), confirmed);
    assert.equal(provider.records().length, count + 1);
    await stop(other);
  });
  await check('lost acknowledgement after provider commit produces UNKNOWN', async () => {
    provider.modes.set('lost', 'lost-ack');
    assert.equal(output(await host.call(input('lost'))).code, 'UNKNOWN');
    assert.equal(provider.records().filter(x => x.operationId === 'lost').length, 1);
  });
  await check('UNKNOWN retry and authoritative ABSENT remain blocked', async () => verifyNoWrites(async () => {
    provider.observations.set('lost', { status: 'ABSENT', authoritative: true, complete: true, observedAt: Date.now() });
    for (let i = 0; i < 2; i++) {
      const blocked = output(await host.call(input('lost')));
      assert.equal(blocked.code, 'UNKNOWN'); assert.equal(blocked.retryAllowed, false);
    }
  }));
  await check('malformed, stale, incomplete, mismatched and non-authoritative reconciliation block', async () => verifyNoWrites(async () => {
    const receipt = provider.records().find(x => x.operationId === 'lost');
    const positive = { status: 'CONFIRMED', authoritative: true, complete: true, observedAt: Date.now(), receipt };
    for (const observation of [
      null, { status: 'CONFIRMED' }, { ...positive, extra: 'malicious' },
      { ...positive, observedAt: Date.now() - 60_000 }, { ...positive, observedAt: Date.now() + 60_000 },
      { ...positive, complete: false }, { ...positive, authoritative: false },
      { ...positive, receipt: { ...receipt, operationId: 'other-intent' } },
      { ...positive, receipt: { ...receipt, effect: { ...receipt.effect, authority: { ...receipt.effect.authority, accountId: 'account-B' } } } },
      { ...positive, receipt: { ...receipt, effect: { ...receipt.effect, providerArgs: { ...order, quantity: 3 } } } },
      { ...positive, receipt: { ...receipt, effect: { ...receipt.effect, resourceId: 'wrong-resource' } } },
      { ...positive, receipt: { ...receipt, effect: { ...receipt.effect, action: 'wrong-tool' } } },
    ]) {
      provider.observations.set('lost', observation);
      assert.equal(output(await host.call(input('lost'))).code, 'UNKNOWN');
    }
  }));
  let recovered;
  await check('authoritative positive reconciliation durably recovers exact receipt', async () => verifyNoWrites(async () => {
    provider.observations.delete('lost');
    recovered = output(await host.call(input('lost')));
    assert.equal(recovered.status, 'CONFIRMED');
    assert.deepEqual(recovered.result, provider.records().find(x => x.operationId === 'lost'));
    provider.observations.set('lost', { status: 'ABSENT' });
    assert.deepEqual(output(await host.call(input('lost'))), recovered);
  }));
  await check('fresh process restart and agent handoff use persisted intent and ledger', async () => verifyNoWrites(async () => {
    const intentPath = path.join(dir, 'task-intent.json');
    writeFileSync(intentPath, JSON.stringify({ input: input('lost'), statePath, authority: first.result.effect.authority }));
    await stop(host); host = await connect();
    const persisted = JSON.parse(readFileSync(intentPath));
    assert.deepEqual(output(await host.call(persisted.input)), recovered);
    assert.deepEqual(output(await host.call(input('intent-1'))), first);
  }));
  await check('changed verified account conflicts, mutable principal and admission fail closed', async () => verifyNoWrites(async () => {
    provider.setAccount('account-B');
    assert.equal(output(await host.call(input('intent-1'))).code, 'UNSUPPORTED_BOUNDARY');
    const changed = await connect({ accountId: 'account-B' });
    assert.equal(output(await changed.call(input('intent-1'))).code, 'CONFLICT');
    await stop(changed); provider.setAccount('account-A');
    const denied = await connect({ denyAdmission: true });
    assert.equal(output(await denied.call(input('intent-1'))).code, 'UNSUPPORTED_BOUNDARY');
    await stop(denied);
  }));
  await check('credential-bearing, malicious, extra input and unsupported boundary never dispatch', async () => verifyNoWrites(async () => {
    for (const malicious of [
      { ...input('malicious'), Authorization: 'Bearer secret' },
      ...['headers', 'apiKey', 'cookies', 'url', 'tool', 'connector', 'command', 'modulePath', 'callback', 'providerMetadata', 'operationId'].map(key => ({ operationId: 'malicious', args: { ...order, [key]: 'attacker' } })),
      { ...input('malicious'), args: { ...order, quantity: 0 } },
      input('', order), { ...input('malicious'), args: JSON.parse('{"sku":"SKU-1","quantity":2,"destinationId":"address-1","__proto__":{"admin":true}}') },
    ]) assert.equal((await host.call(malicious)).isError, true);
    await assert.rejects(host.call(input('unsupported'), 'adobe_any_write'));
  }));
  await check('provider semantic failure and MCP isError cannot become CONFIRMED', async () => {
    const count = provider.records().length;
    for (const mode of ['semantic-failure', 'mcp-isError']) {
      provider.modes.set(mode, mode);
      assert.equal(output(await host.call(input(mode))).code, 'UNKNOWN');
      const posts = provider.counters.posts;
      assert.equal(output(await host.call(input(mode))).code, 'UNKNOWN');
      assert.equal(provider.counters.posts, posts);
    }
    assert.equal(provider.records().length, count);
  });
  await check('mismatched execution receipt stays UNKNOWN until exact provider recovery', async () => {
    provider.modes.set('bad-receipt', 'bad-receipt');
    assert.equal(output(await host.call(input('bad-receipt'))).code, 'UNKNOWN');
    const posts = provider.counters.posts;
    assert.equal(output(await host.call(input('bad-receipt'))).status, 'CONFIRMED');
    assert.equal(provider.counters.posts, posts);
  });
  await check('process crash after provider commit: live lease blocks then lookup recovers', async () => {
    const crash = await connect();
    provider.modes.set('crash', 'hold');
    const count = provider.records().length;
    const pending = crash.call(input('crash')).catch(() => undefined);
    await waitUntil(() => provider.records().length === count + 1);
    process.kill(crash.transport.pid, 'SIGKILL'); await pending; await stop(crash);
    const posts = provider.counters.posts;
    assert.equal(output(await host.call(input('crash'))).code, 'IN_FLIGHT');
    // Fault injection advances the abandoned claim's lease, without changing
    // identity/effect/state or introducing a new execution right.
    const db = new DatabaseSync(statePath);
    db.prepare("UPDATE local_operations SET lease_until=0 WHERE id='crash'").run(); db.close();
    assert.equal(output(await host.call(input('crash'))).status, 'CONFIRMED');
    assert.equal(provider.counters.posts, posts); provider.release();
  });
  await check('missing, corrupt and unavailable state never create a replacement authority', async () => verifyNoWrites(async () => {
    const missing = path.join(dir, 'missing.sqlite');
    await assert.rejects(connect({ statePath: missing })); assert.equal(existsSync(missing), false);
    const corrupt = path.join(dir, 'corrupt.sqlite'); writeFileSync(corrupt, 'not sqlite');
    await assert.rejects(connect({ statePath: corrupt }));
    const empty = path.join(dir, 'empty.sqlite'); writeFileSync(empty, '');
    await assert.rejects(connect({ statePath: empty }));
    await assert.rejects(connect({ statePath: dir }));
    if (process.platform === 'win32') {
      // Windows prevents replacement of an open SQLite file. Inject schema
      // corruption instead; both a new action and retained replay fail closed.
      const db = new DatabaseSync(statePath);
      db.exec('DROP TABLE local_operations'); db.close();
      assert.equal(output(await host.call(input('new-after-loss'))).code, 'STATE_UNAVAILABLE');
      assert.equal(output(await host.call(input('intent-1'))).code, 'STATE_UNAVAILABLE');
      await stop(host);
      renameSync(statePath, path.join(dir, 'original.sqlite'));
      await assert.rejects(connect()); assert.equal(existsSync(statePath), false);
    } else {
      // Path replacement is detected by the existing SDK session, even if a
      // valid unrelated database is placed at the same pathname.
      const replacement = path.join(dir, 'replacement.sqlite');
      const db = new DatabaseSync(replacement); db.close();
      renameSync(statePath, path.join(dir, 'original.sqlite'));
      renameSync(replacement, statePath);
      assert.equal(output(await host.call(input('new-after-loss'))).code, 'STATE_UNAVAILABLE');
      renameSync(statePath, replacement); renameSync(path.join(dir, 'original.sqlite'), statePath);
      assert.equal(output(await host.call(input('intent-1'))).code, 'STATE_UNAVAILABLE');
    }
  }));
  await check('direct raw provider bypass is observable and outside protection', async () => {
    const receipt = provider.records()[0];
    const count = provider.records().length;
    const response = await fetch(`${provider.url}/orders`, { method: 'POST', headers: { Authorization: `Bearer ${provider.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: receipt.operationId, effect: receipt.effect }) });
    assert.equal(response.status, 200); await response.json();
    assert.equal(provider.records().length, count + 1);
    assert.equal(provider.records().filter(x => x.operationId === 'intent-1').length, 2);
  });
  assert.equal(readFileSync(path.join(dir, 'provider-effects.jsonl'), 'utf8').includes(provider.token), false);
  if (process.env.ONCE_TEST_PROOF_PATH) writeFileSync(process.env.ONCE_TEST_PROOF_PATH, JSON.stringify({ runtime: process.version, transport: 'actual stdio MCP -> authenticated loopback HTTP provider', scenarios: proof, providerRecords: provider.records(), counters: provider.counters }, null, 2));
});

test('unsupported registration without a trusted provider/admission contract fails closed', async () => {
  const server = new McpServer({ name: 'unsupported-fixture', version: '1' });
  await assert.rejects(registerProtectedOrderAction(server, {
    authority: { provider: 'disposable-orders', accountId: 'account-A', environment: 'local-test' }, resourceId: 'orders', statePath: path.resolve('missing.sqlite'), provider: {},
  }), { code: 'UNSUPPORTED_BOUNDARY' });
  await server.close();
});

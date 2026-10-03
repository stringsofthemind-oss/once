import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { wrapTool } from '../dist/index.js';

test('real MCP client/server: before tools/call, replay, conflict, lost ack and read-only reconciliation', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'once-wrap-mcp-'));
  const effects = [];
  const calls = [];
  const client = new Client({ name: 'placement-host', version: '1.0.0' });
  const server = new Server({ name: 'disposable-provider', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['append', 'lookup'].map(name => ({ name, inputSchema: { type: 'object' } })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    calls.push(request.params.name);
    if (request.params.name === 'append') effects.push({ ...request.params.arguments });
    const found = effects.filter(x => x.intent === request.params.arguments.intent);
    return { content: [{ type: 'text', text: JSON.stringify(found) }] };
  });
  const [hostTransport, providerTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  await server.connect(providerTransport);
  await client.connect(hostTransport);
  assert.equal((await client.listTools()).tools.length, 2);
  const options = {
    statePath: path.join(dir, 'state.sqlite'),
    operationId: x => x.intent,
    effect: x => ({ tool: 'mcp.disposable-provider.account-A.append', args: { intent: x.intent, body: x.body } }),
  };
  const dispatch = args => client.callTool({ name: 'append', arguments: args });
  const run = wrapTool(dispatch, options);
  const input = { intent: 'mcp-1', body: 'hello', traceId: 'transport-1' };
  const first = await run(input);
  assert.deepEqual(await run({ ...input, traceId: 'transport-2' }), first);
  await assert.rejects(run({ ...input, body: 'changed' }), { code: 'CONFLICT' });
  const otherAuthority = wrapTool(dispatch, { ...options, effect: x => ({ tool: 'mcp.disposable-provider.account-B.append', args: { intent: x.intent, body: x.body } }) });
  await assert.rejects(otherAuthority(input), { code: 'CONFLICT' });
  assert.equal(effects.length, 1);
  assert.equal(calls.filter(x => x === 'append').length, 1);

  const lostInput = { intent: 'mcp-lost', body: 'lost-ack' };
  const lost = wrapTool(async args => { await dispatch(args); throw Error('drop host acknowledgement'); }, options);
  await assert.rejects(lost(lostInput), { code: 'UNKNOWN' });
  await assert.rejects(run(lostInput), { code: 'UNKNOWN' });
  const recover = wrapTool(dispatch, { ...options, reconcile: async ({ effect }) => {
    const receipt = await client.callTool({ name: 'lookup', arguments: { intent: effect.args.intent } });
    const matches = JSON.parse(receipt.content[0].text);
    if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(effect.args)) return { status: 'UNKNOWN' };
    return { status: 'CONFIRMED', result: receipt };
  } });
  const recovered = await recover(lostInput);
  assert.deepEqual(await run(lostInput), recovered);
  assert.deepEqual(effects, [{ intent: 'mcp-1', body: 'hello' }, { intent: 'mcp-lost', body: 'lost-ack' }]);
  assert.equal(calls.filter(x => x === 'append').length, 2);
  assert.equal(calls.filter(x => x === 'lookup').length, 1);
});

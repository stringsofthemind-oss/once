import assert from 'node:assert/strict';
import test from 'node:test';
import * as sdk from '@once-agent/sdk';
import { McpServer } from '@modelcontextprotocol/server';
import { registerProtectedOrderAction } from '@once-agent/mcp/registered-action';
test('intent mode never silently downgrades on a legacy SDK or accepts both authorities', async () => {
  let callbacks = 0;
  const server = new McpServer({ name: 'intent-admission-denial', version: '1' });
  const options = {
    authority: { provider: 'disposable-orders', accountId: 'account-A', environment: 'local-test' }, resourceId: 'orders-local',
    statePath: process.cwd(),
    intentAuthority: { authority: { contract: 'once-host-intent-v2', open: async () => { callbacks++; throw Error('must not open'); }, resolveIntent: async () => { callbacks++; throw Error('must not resolve'); } }, scope: 'scope', resolveKey: async () => 'slot' },
    authorize: async () => { callbacks++; }, provider: Object.fromEntries(['assertAuthority','create','lookup'].map(key => [key, async () => { callbacks++; throw Error('must not reach provider'); }])),
  };
  await assert.rejects(registerProtectedOrderAction(server, options), { code: 'UNSUPPORTED_BOUNDARY' });
  if (sdk.HOST_INTENT_AUTHORITY_CONTRACT !== 'once-host-intent-v2') {
    delete options.statePath;
    await assert.rejects(registerProtectedOrderAction(server, options), { code: 'UNSUPPORTED_BOUNDARY' });
  }
  assert.equal(callbacks, 0);
});

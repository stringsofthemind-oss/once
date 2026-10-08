import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const entry = createRequire(import.meta.url).resolve('@once-agent/mcp');
async function verify(t, key, baseUrl) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'once-connection-consumer-'));
  const client = new Client({ name: 'connection-regression', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd,
    env: { ...process.env, ONCE_API_KEY: key, ONCE_BASE_URL: baseUrl }, stderr: 'pipe' });
  t.after(async () => { await client.close(); rmSync(cwd, { recursive: true, force: true }); });
  await client.connect(transport);
  return client.callTool({ name: 'once_verify_connection', arguments: {} });
}
async function cloud(t, response, status = 200) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url });
    assert.equal(req.headers.authorization, 'Bearer fixture-only-key');
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}
test('no credential preserves local diagnostics without claiming Cloud verification', async t => {
  for (const key of ['', '   ']) {
    const response = await verify(t, key, 'http://127.0.0.1:1');
    const result = response.structuredContent;
    assert.equal(result.ok, true); assert.equal(response.isError, false);
    assert.equal(result.localValidated, true); assert.equal(result.cloudConfigured, false);
    assert.equal(result.cloudVerified, false); assert.equal(result.cloudStatus, 'unconfigured');
    assert.deepEqual(result.command, ['once', 'doctor']); assert.equal(result.exitCode, 0);
    for (const field of ['cwd','stdout','stderr','timedOut']) assert.ok(field in result);
    assert.match(response.content[0].text, /unconfigured and unverified/);
    assert.equal(result.cloudCheck, undefined);
  }
});
test('configured Cloud success needs actual read-only truth/safety checks', async t => {
  const fixture = await cloud(t, { operation_id: 'probe', ledger_state: 'ABSENT', side_effects: 0 });
  const response = await verify(t, 'fixture-only-key', fixture.base);
  assert.equal(response.isError, false); assert.equal(response.structuredContent.ok, true);
  assert.equal(response.structuredContent.localValidated, true);
  assert.equal(response.structuredContent.cloudConfigured, true);
  assert.equal(response.structuredContent.cloudVerified, true);
  assert.equal(response.structuredContent.cloudStatus, 'verified');
  assert.deepEqual(response.structuredContent.cloudCheck.command, ['once','doctor','--connection']);
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0].method, 'GET');
  assert.match(fixture.calls[0].path, /^\/v1\/truth\/doctor-/);
  assert.doesNotMatch(JSON.stringify(response), /fixture-only-key/);
});
test('failed Cloud authentication cannot be masked by successful local scan', async t => {
  const fixture = await cloud(t, { error: { code: 'UNAUTHORIZED', message: 'Invalid key' } }, 401);
  const response = await verify(t, 'fixture-only-key', fixture.base);
  assert.equal(response.structuredContent.localValidated, true);
  assert.equal(response.structuredContent.cloudConfigured, true);
  assert.equal(response.structuredContent.cloudVerified, false);
  assert.equal(response.structuredContent.cloudStatus, 'failed');
  assert.equal(response.structuredContent.ok, false); assert.equal(response.isError, true);
  assert.equal(fixture.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(response), /fixture-only-key/);
});
test('reachable truth endpoint with unsafe probe result is not Cloud verified', async t => {
  const fixture = await cloud(t, { ledger_state: 'UNKNOWN', side_effects: 1 });
  const response = await verify(t, 'fixture-only-key', fixture.base);
  assert.equal(response.structuredContent.localValidated, true);
  assert.equal(response.structuredContent.cloudVerified, false);
  assert.equal(response.structuredContent.ok, false); assert.equal(response.isError, true);
});

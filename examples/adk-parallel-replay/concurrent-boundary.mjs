// Additional boundary qualification: independent provider SQLite, fresh workers.
// This does not qualify ADK's parallel runner or distributed storage.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [sdkUrl, output] = process.argv.slice(2);
assert(sdkUrl && output, 'Usage: node concurrent-boundary.mjs SDK_FILE_URL OUTPUT');
rmSync(output, {force: true});
const root = mkdtempSync(join(tmpdir(), 'once-adk-concurrent-'));
const journal = new DatabaseSync(join(root, 'provider.sqlite'));
journal.exec('CREATE TABLE effects(id INTEGER PRIMARY KEY, operation TEXT, effect TEXT)');
const rows = () => journal.prepare('SELECT * FROM effects ORDER BY id').all();
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const entry = journal.prepare('INSERT INTO effects(operation,effect) VALUES (?,?)')
    .run(request.operationId, JSON.stringify(request.effect));
  // Hold acceptance response so duplicate workers overlap an active dispatch.
  await new Promise(resolve => setTimeout(resolve, 250));
  res.end(JSON.stringify({ ticket_id: Number(entry.lastInsertRowid), effect: request.effect }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const effect = {tool: 'fixture.tenant-A.create_ticket', args: {project: 'disposable', title: 'disk full'}};
const request = {sdkUrl, operationId: 'concurrent-intent', effect, leaseMs: 30000,
  statePath: join(root, 'once.sqlite'), providerUrl: `http://127.0.0.1:${server.address().port}`};
const call = change => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('boundary.mjs', import.meta.url))]);
  const timer = setTimeout(() => { child.kill(); reject(Error('Boundary timed out')); }, 15000);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  child.on('error', reject);
  child.on('exit', code => {
    clearTimeout(timer);
    try { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
  });
  child.stdin.end(JSON.stringify({...request, ...change}));
});
try {
  const concurrent = await Promise.all(Array.from({length: 12}, () => call({})));
  assert.equal(rows().length, 1);
  assert(concurrent.some(result => result.status === 'CONFIRMED'));
  // SQLite first-open contention may fail closed as STATE_UNAVAILABLE.
  assert(concurrent.every(result => ['CONFIRMED', 'UNKNOWN', 'IN_FLIGHT', 'STATE_UNAVAILABLE'].includes(result.status)), JSON.stringify(concurrent));
  const replay = await call({expectedState: true});
  assert.equal(replay.status, 'CONFIRMED');
  assert.equal(rows().length, 1);
  const recovered = [];
  for (const result of concurrent.filter(result => result.status !== 'CONFIRMED')) {
    const retry = await call({expectedState: true});
    assert.deepEqual(retry, replay);
    assert.equal(rows().length, 1);
    recovered.push({initial: result.status, retry});
  }
  const invalid = [];
  for (const badEffect of [null, {}, {tool: '', args: {}}, {tool: 'x', args: []}, {...effect, url: 'unreviewed'}]) {
    const result = await call({effect: badEffect});
    assert.equal(result.status, 'INVALID_EFFECT');
    assert.equal(rows().length, 1);
    invalid.push(result);
  }
  const conflict = await call({effect: {...effect, args: {...effect.args, title: 'changed'}}});
  assert.equal(conflict.status, 'CONFLICT');
  assert.equal(rows().length, 1);
  const freshIntent = await call({operationId: 'intentional-second'});
  assert.equal(freshIntent.status, 'CONFIRMED');
  assert.equal(rows().length, 2);
  writeFileSync(output, JSON.stringify({status: 'PASS', scope: 'same-machine boundary; not ADK runner concurrency',
    workers: 12, concurrent, replay, recovered, invalid, conflict, freshIntent, provider_effects: rows()}, null, 2));
  console.log('PASS: 12 concurrent workers, one original effect; five invalid shapes blocked; distinct intent adds one effect.');
} finally {
  await new Promise(resolve => server.close(resolve));
  journal.close();
  rmSync(root, {recursive: true, force: true});
}

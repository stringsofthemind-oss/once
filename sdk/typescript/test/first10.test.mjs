import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/once-cli.js', import.meta.url));
test('canonical proof counts separate provider effects across new callers', () => {
  const result = spawnSync(process.execPath, [cli, 'prove'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 provider writes/);
  assert.match(result.stdout, /RETRY BLOCKED/);
  assert.match(result.stdout, /UNKNOWN -> CONFIRMED/);
  const directory = result.stdout.match(/Evidence: (.+)/)[1].trim();
  const report = JSON.parse(readFileSync(path.join(directory, 'report.json'), 'utf8'));
  assert.equal(report.scenarios['without-once'].writes, 2);
  assert.equal(report.scenarios['lost-ack'].writes, 1);
  assert.equal(report.scenarios['lost-ack'].unsafeRedispatches, 0);
  assert.deepEqual(report.scenarios['without-once'].observedCounts, [0, 1, 2]);
  assert.deepEqual(report.scenarios['lost-ack'].observedCounts, [0, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(report.scenarios.confirmed.conflictAdditionalWrites, 0);
});
test('check is read-only even with an API key and refuses apply', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'once-check-test-'));
  const source = 'export async function refundCustomer(input) { return fetch("https://example.invalid", {method: "POST", body: JSON.stringify(input)}); }';
  writeFileSync(path.join(root, 'refund.mjs'), source);
  const result = spawnSync(process.execPath, [cli, 'check', root], { encoding: 'utf8', env: {...process.env, ONCE_API_KEY: 'test-not-a-real-key'}, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Potential consequential operation/);
  assert.match(result.stdout, /Developer review required/);
  assert.equal(readFileSync(path.join(root, 'refund.mjs'), 'utf8'), source);
  assert.deepEqual(readdirSync(root), ['refund.mjs']);
  const invalid = spawnSync(process.execPath, [cli, 'check', root, '--apply'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  const arbitrary = spawnSync(process.execPath, [cli, 'prove', path.join(root, 'refund.mjs')], { encoding: 'utf8' });
  assert.equal(arbitrary.status, 1);
});

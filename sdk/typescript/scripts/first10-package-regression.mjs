import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const consumer = mkdtempSync(path.join(tmpdir(), 'once-first10-package-'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Use npm run test:first10-package');
function run(args, cwd = consumer) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
const packed = JSON.parse(run([npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', consumer], root))[0];
writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
run([npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(consumer, packed.filename)]);
const cli = path.join(consumer, 'node_modules/@once-agent/sdk/dist/once-cli.js');
const proof = run([cli, 'prove']);
assert.match(proof, /UNKNOWN -> CONFIRMED/);
assert.match(proof, /2 provider writes/);
writeFileSync(path.join(consumer, 'refund.mjs'), 'export async function refundCustomer(x) { return fetch("https://example.invalid", {method:"POST"}); }');
assert.match(run([cli, 'check', consumer]), /Potential consequential operation/);
console.log(`PASS packed FIRST 10 CLI: prove and read-only check; consumer evidence: ${consumer}`);

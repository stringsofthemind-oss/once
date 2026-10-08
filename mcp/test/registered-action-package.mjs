import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(path.join(os.tmpdir(), 'once-registered-package-'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'run via npm run test:registered-action-package');
function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', env: process.env, windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const packed = JSON.parse(run(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', temp], root))[0];
  assert.ok(packed.files.some(x => x.path === 'dist/registered-action.js'));
  assert.ok(packed.files.some(x => x.path === 'dist/registered-action.d.ts'));
  assert.equal(packed.files.some(x => /github|host-config|operations\.sqlite|fault-control|bundle|cache/.test(x.path)), false);
  assert.ok(packed.files.some(x => x.path === 'dist/existing-ledger.js'));
  assert.equal(packed.files.some(x => x.path.includes('test/')), false);
  const consumer = path.join(temp, 'consumer'); mkdirSync(consumer);
  writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'disposable-packed-consumer', version: '1.0.0', private: true, type: 'module' }));
  run(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packed.filename)], consumer);
  const readPackage = name => JSON.parse(readFileSync(path.join(consumer, 'node_modules', name, 'package.json')));
  const sdk = readPackage('@once-agent/sdk');
  const mcp = readPackage('@once-agent/mcp');
  assert.equal(sdk.version, '0.1.25'); assert.equal(mcp.dependencies['@once-agent/sdk'], '0.1.25');
  assert.equal(mcp.exports['./github-issue'], undefined);
  const privateImport = spawnSync(process.execPath, ['--input-type=module', '-e', "import('@once-agent/mcp/dist/github-issue.js')"], { cwd: consumer, encoding: 'utf8', windowsHide: true });
  assert.notEqual(privateImport.status, 0, 'Private GitHub adapter must be unavailable to a public consumer.');
  cpSync(path.join(root, 'test'), path.join(consumer, 'test'), { recursive: true });
  const results = run(process.execPath, ['--test', 'test/registered-action.test.mjs', 'test/connection-verification.test.mjs'], consumer);
  cpSync(path.join(root, 'scripts', 'smoke.mjs'), path.join(consumer, 'smoke.mjs'));
  console.log(run(process.execPath, [path.join(consumer, 'smoke.mjs')], path.join(consumer, 'node_modules', '@once-agent', 'mcp')));
  console.log(results);
  const report = { mcpVersion: mcp.version, sdkVersion: sdk.version, integrity: packed.integrity, exports: mcp.exports, installedConsumerTest: results };
  if (process.env.ONCE_TEST_PACKAGE_PROOF_PATH) writeFileSync(process.env.ONCE_TEST_PACKAGE_PROOF_PATH, JSON.stringify(report, null, 2));
  console.log('PACKED REGISTERED ACTION: PASS (installed MCP package + published SDK 0.1.25)');
} finally {
  // Only the exact directory returned by mkdtemp is removed.
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  rmSync(temp, { recursive: true, force: true });
}

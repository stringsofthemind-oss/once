import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const consumer = mkdtempSync(path.join(os.tmpdir(), 'once-wrap-package-'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this regression through npm run test:wrap-tool-package');
function run(command, args, cwd = consumer) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
try {
  const packed = JSON.parse(run(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', consumer], root))[0];
  writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(consumer, packed.filename)]);
  copyFileSync(path.join(root, 'test/wrap-tool-consumer.mjs'), path.join(consumer, 'proof.mjs'));
  copyFileSync(path.join(root, 'test/wrap-tool-consumer.mts'), path.join(consumer, 'types.mts'));
  console.log(run(process.execPath, ['proof.mjs']).trim());
  run(process.execPath, [path.join(consumer, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck', 'types.mts']);
  console.log('wrapTool packed consumer: ESM/CJS 14 checks; exported TypeScript positive and negative contracts PASS');
} finally { rmSync(consumer, { recursive: true, force: true }); }

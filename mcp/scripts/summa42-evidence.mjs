import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const parent = path.resolve(process.argv[2] ?? 'summa42-runs');
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(path.join(parent, 'run-'));
const source = fileURLToPath(new URL('../test/summa42.test.mjs', import.meta.url));
const command = [process.execPath, '--test', '--test-reporter=tap', source];
const execution = { startedAt: new Date().toISOString(), command, runtime: process.version, platform: process.platform,
  suiteSha256: createHash('sha256').update(readFileSync(source)).digest('hex'), packages: {} };
for (const specifier of ['@once-agent/sdk', '@once-agent/mcp/registered-action']) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve(specifier))));
  execution.packages[pkg.name] = pkg.version;
}
let transcript = '';
const child = spawn(command[0], command.slice(1), { env: { ...process.env, ONCE_SUMMA42_RESULTS: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { transcript += chunk; process.stdout.write(chunk); });
const timer = setTimeout(() => child.kill(), 240000);
child.on('error', error => { execution.spawnError = error.message; });
child.on('close', (code, signal) => {
  clearTimeout(timer);
  Object.assign(execution, { finishedAt: new Date().toISOString(), exitCode: code, signal });
  writeFileSync(path.join(directory, 'test-output.tap'), transcript);
  writeFileSync(path.join(directory, 'execution.json'), JSON.stringify(execution, null, 2));
  console.log(`Saved evidence: ${directory}`);
  process.exitCode = code ?? 1;
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const destination = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Use npm run package:summa42 -- ABSOLUTE_NEW_OUTPUT_DIRECTORY');
assert.ok(!existsSync(destination), 'Output directory must not already exist');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run through npm run package:summa42');
const run = (exe, args, cwd = repo) => {
  const result = spawnSync(exe, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
for (const directory of ['sdk/typescript', 'mcp']) run(process.execPath, [npmCli, 'run', 'build'], path.join(repo, directory));
mkdirSync(path.join(destination, 'vendor'), { recursive: true });
const packages = {};
for (const directory of ['sdk/typescript', 'mcp']) {
  const [packed] = JSON.parse(run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', path.join(destination, 'vendor')], path.join(repo, directory)));
  packages[packed.name] = { version: packed.version, filename: packed.filename, integrity: packed.integrity, sha256: createHash('sha256').update(readFileSync(path.join(destination, 'vendor', packed.filename))).digest('hex') };
}
const copied = [
  'mcp/test/summa42.test.mjs', 'mcp/test/fixtures/order-host.mjs', 'mcp/test/fixtures/order-provider.mjs',
  'mcp/scripts/summa42-evidence.mjs', 'mcp/scripts/verify-summa42.mjs',
];
for (const relative of copied) {
  const target = path.join(destination, relative.slice(4)); mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(repo, relative), target);
}
for (const filename of ['README.md', 'EVIDENCE.md', 'GITHUB-RESPONSE.md']) copyFileSync(path.join(repo, 'examples/summa42-hostile-retry', filename), path.join(destination, filename));
copyFileSync(path.join(repo, 'LICENSE'), path.join(destination, 'LICENSE'));
const auditFiles = ['AGENTS.md', 'docs/published-versions.json', 'sdk/typescript/src/local.ts', 'sdk/typescript/src/tool-call.ts',
  'sdk/typescript/src/connect/mcp-execution-boundary.ts', 'sdk/typescript/src/connect/identity.ts',
  'mcp/src/registered-action.ts', 'mcp/src/existing-ledger.ts', 'mcp/test/registered-action.test.mjs',
  'sdk/typescript/test/tool-call.test.mjs', 'examples/first10/prove.mjs'];
const sourceHashes = {};
for (const relative of [...auditFiles, ...copied]) {
  sourceHashes[relative] = createHash('sha256').update(readFileSync(path.join(repo, relative))).digest('hex');
  const target = path.join(destination, 'source', relative); mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(repo, relative), target);
}
const provenance = { schema: 'once-summa42-provenance-v1', generatedAt: new Date().toISOString(),
  repository: 'https://github.com/stringsofthemind-oss/once', baseRevision: run('git', ['merge-base', 'HEAD', 'origin/main']).trim(),
  checkoutRevision: run('git', ['rev-parse', 'HEAD']).trim(), branch: run('git', ['branch', '--show-current']).trim(),
  status: run('git', ['status', '--short']), packages, sourceHashes, artifactQualification: 'local source builds; not publication evidence',
  criterionSource: 'https://github.com/SofiaFlux/summa42/issues/35' };
writeFileSync(path.join(destination, 'provenance.json'), JSON.stringify(provenance, null, 2));
writeFileSync(path.join(destination, 'source', 'tracked-changes.patch'), run('git', ['diff', '--binary', 'HEAD']));
writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ name: 'once-summa42-evidence', version: '1.0.0', private: true, type: 'module',
  engines: { node: '>=24.15.0' }, scripts: { test: 'node scripts/summa42-evidence.mjs', verify: 'node scripts/verify-summa42.mjs' },
  dependencies: { '@once-agent/sdk': `file:vendor/${packages['@once-agent/sdk'].filename}`, '@once-agent/mcp': `file:vendor/${packages['@once-agent/mcp'].filename}`, '@modelcontextprotocol/client': '2.3.1' },
  overrides: { '@once-agent/sdk': '$@once-agent/sdk' },
}, null, 2));
console.log(`Created standalone package: ${destination}\nNext: npm install --package-lock-only --ignore-scripts --no-audit --no-fund, then npm ci --ignore-scripts and npm test in that directory.`);

// Reuse the baseline packager; only add the admitted host profile and its SQL.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const destination = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2] && !existsSync(destination), 'Supply an absolute new output directory');
const baseline = spawnSync(process.execPath, [fileURLToPath(new URL('./package-summa42.mjs', import.meta.url)), destination], { env: process.env, stdio: 'inherit' });
assert.equal(baseline.status, 0);
const repo = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(path.join(destination, 'baseline-docs'));
for (const file of ['README.md', 'EVIDENCE.md', 'GITHUB-RESPONSE.md']) copyFileSync(path.join(destination, file), path.join(destination, 'baseline-docs', file));
const reference = path.join(repo, 'examples/summa42-host-integration');
copyFileSync(path.join(reference, 'EVIDENCE-PACKAGE.md'), path.join(destination, 'README.md'));
writeFileSync(path.join(destination, 'ACTUAL-SUMMA42.md'), readFileSync(path.join(reference, 'README.md'), 'utf8').replaceAll('examples/summa42-host-integration/main.go', 'reference/main.go').replaceAll('mcp/scripts/summa42-host-proof.mjs', 'scripts/summa42-host-proof.mjs'));
copyFileSync(path.join(reference, 'compose.yaml'), path.join(destination, 'compose.yaml'));
copyFileSync(path.join(reference, 'ACCEPTANCE.md'), path.join(destination, 'ACCEPTANCE.md'));
copyFileSync(path.join(repo, 'docs/SILENT_CHICKEN.md'), path.join(destination, 'ENGINEERING.md'));
mkdirSync(path.join(destination, 'reference')); copyFileSync(path.join(reference, 'main.go'), path.join(destination, 'reference/main.go'));
for (const file of ['scripts/silent-chicken-evidence.mjs', 'scripts/verify-hardening.mjs', 'scripts/verify-summa42-host.mjs', 'scripts/summa42-host-proof.mjs', 'test/silent-chicken.test.mjs', 'test/intent-capability.test.mjs', 'test/registered-action.test.mjs', 'test/connection-verification.test.mjs']) {
 const target = path.join(destination, file); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(path.join(repo, 'mcp', file), target);
}
cpSync(path.join(repo, 'sdk/typescript/sql'), path.join(destination, 'sql'), { recursive: true });
const pkgFile = path.join(destination, 'package.json'), pkg = JSON.parse(readFileSync(pkgFile));
pkg.name = 'once-silent-chicken-evidence'; pkg.scripts['test:baseline'] = pkg.scripts.test;
pkg.scripts.test = 'node scripts/silent-chicken-evidence.mjs'; pkg.scripts.verify = 'node scripts/verify-hardening.mjs';
pkg.scripts['verify:summa42-host'] = 'node scripts/verify-summa42-host.mjs';
pkg.scripts['test:regression'] = 'node --test test/registered-action.test.mjs test/connection-verification.test.mjs test/intent-capability.test.mjs';
pkg.scripts['test:summa42-host'] = 'node scripts/summa42-host-proof.mjs'; pkg.dependencies.pg = '8.16.3';
writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
const provenanceFile = path.join(destination, 'provenance.json'), provenance = JSON.parse(readFileSync(provenanceFile));
const changed = spawnSync('git', ['diff', '--name-only', 'origin/main'], { cwd: repo, encoding: 'utf8' }); assert.equal(changed.status, 0);
for (const file of changed.stdout.trim().split('\n').filter(Boolean)) {
 const target = path.join(destination, 'source', file); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(path.join(repo, file), target);
 provenance.sourceHashes[file] = createHash('sha256').update(readFileSync(path.join(repo, file))).digest('hex');
}
const patch = spawnSync('git', ['diff', '--binary', 'origin/main'], { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); assert.equal(patch.status, 0);
writeFileSync(path.join(destination, 'source/complete-source.patch'), patch.stdout);
provenance.summa42Revision = 'efc6794ea79a4be5b2f60e376833a1d03cba053c';
provenance.reusedAuthorityRevision = 'ae906f64fa6c532d8f2052f4d13d9f13002fa077';
writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2));
console.log(`Created independent admitted-host package: ${destination}`);

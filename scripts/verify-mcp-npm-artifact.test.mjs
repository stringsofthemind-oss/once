import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { matchesReviewedArtifact } from './verify-mcp-npm-artifact.mjs';
const expected = { name: '@once-agent/mcp', version: '0.2.0', integrity: 'sha512-' + 'A'.repeat(86) + '==' };
const metadata = { name: expected.name, version: expected.version, dist: { integrity: expected.integrity } };
test('only exact reviewed public version and integrity match', () => assert.equal(matchesReviewedArtifact(expected, metadata, '0.2.0'), true));

test('reviewed artifact record agrees with package and Registry manifest and stays outside npm contents', () => {
  const pkg = JSON.parse(readFileSync(new URL('../mcp/package.json', import.meta.url)));
  const server = JSON.parse(readFileSync(new URL('../mcp/server.json', import.meta.url)));
  const record = JSON.parse(readFileSync(new URL('../mcp/release-artifact.json', import.meta.url)));
  assert.equal(matchesReviewedArtifact(record, { name: record.name, version: record.version, dist: { integrity: record.integrity } }, pkg.version), true);
  assert.equal(record.version, server.version);
  assert.equal(record.version, server.packages[0].version);
  assert.match(record.sha256, /^[a-f0-9]{64}$/);
  assert.equal(pkg.files.includes('release-artifact.json'), false);
});
test('missing, malformed, wrong version/package/integrity block', () => {
  for (const value of [undefined, {}, { ...metadata, name: 'other' }, { ...metadata, version: '0.1.5' }, { ...metadata, dist: {} }, { ...metadata, dist: { integrity: 'sha512-' + 'B'.repeat(86) + '==' } }]) assert.equal(Boolean(matchesReviewedArtifact(expected, value, '0.2.0')), false);
  assert.equal(Boolean(matchesReviewedArtifact({}, metadata, '0.2.0')), false);
  assert.equal(Boolean(matchesReviewedArtifact(expected, metadata, '0.1.5')), false);
});
test('registry publication requires independent npm confirmation before OIDC and publication', () => {
  const workflow = readFileSync(new URL('../.github/workflows/mcp-registry-publish.yml', import.meta.url), 'utf8');
  const gate = workflow.indexOf('Require exact reviewed npm artifact');
  assert.ok(gate > workflow.indexOf('  publish:') && gate < workflow.indexOf('Authenticate to MCP Registry'));
  assert.match(workflow.slice(gate), /node scripts\/verify-mcp-npm-artifact.mjs/);
  assert.match(workflow.slice(gate), /exit 1/);
});

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function matchesReviewedArtifact(expected, metadata, version) {
  return expected?.name === '@once-agent/mcp' && expected.version === version &&
    typeof expected.integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(expected.integrity) &&
    metadata?.name === expected.name && metadata.version === expected.version && metadata.dist?.integrity === expected.integrity;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expected = JSON.parse(readFileSync('mcp/release-artifact.json', 'utf8'));
  const pkg = JSON.parse(readFileSync('mcp/package.json', 'utf8'));
  if (!matchesReviewedArtifact(expected, { name: expected.name, version: expected.version, dist: { integrity: expected.integrity } }, pkg.version)) throw Error('Missing or incompatible reviewed npm artifact. Publication blocked.');
  const response = await fetch(`https://registry.npmjs.org/@once-agent%2Fmcp/${encodeURIComponent(pkg.version)}`, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' } });
  if (response.status !== 200 || !matchesReviewedArtifact(expected, await response.json(), pkg.version)) throw Error('Exact reviewed npm artifact not independently confirmed. Registry publication blocked.');
  console.log('Exact reviewed npm version and integrity independently confirmed.');
}

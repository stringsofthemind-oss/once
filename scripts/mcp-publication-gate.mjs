import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function publicationAllowed({ eventName, ref, before, after, head, readVersions }) {
  if (eventName === 'workflow_dispatch') return true;
  if (eventName === 'pull_request') return false;
  if (eventName !== 'push' || ref !== 'refs/heads/main') return false;
  const valid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) && !/^0+$/.test(value);
  if (!valid(before) || !valid(after) || head !== after) throw Error('Cannot establish exact push comparison. Publication blocked.');
  const old = readVersions(before), current = readVersions(after);
  for (const versions of [old, current]) {
    if (typeof versions.package !== 'string' || !versions.package || versions.package !== versions.manifest || versions.package !== versions.registryPackage) throw Error('Incompatible version comparison. Publication blocked.');
  }
  return current.package !== old.package;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Write the blocking output first. Any missing object, invalid event or parse
  // failure fails the validation job; publication requires its successful output.
  appendFileSync(process.env.GITHUB_OUTPUT, 'publish_allowed=false\n');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const allowed = publicationAllowed({
    eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    before: event.before, after: event.after, head: git(['rev-parse', 'HEAD']),
    readVersions: revision => {
      const pkg = JSON.parse(git(['show', `${revision}:mcp/package.json`]));
      const manifest = JSON.parse(git(['show', `${revision}:mcp/server.json`]));
      return { package: pkg.version, manifest: manifest.version, registryPackage: manifest.packages?.[0]?.version };
    },
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `publish_allowed=${allowed}\n`);
  console.log(allowed ? 'Intentional publication path eligible.' : 'Publication skipped before credentials or publisher execution.');
}

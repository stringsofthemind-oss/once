import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
export function currentOnboardingSurfaces() {
  return {
    version: JSON.parse(read("docs/published-versions.json")).ts,
    rootReadme: read("README.md"),
    sdkReadme: read("sdk/typescript/README.md"),
    agentGuide: read("docs/agent.md"),
    llms: read("docs/llms.txt"),
    html: read("docs/index.html"),
    start: read("docs/START_HERE.md"),
    recovery: read("sdk/typescript/examples/GITHUB_ISSUE_RECOVERY.md"),
    mcpDependency: JSON.parse(read("mcp/package.json")).dependencies["@once-agent/sdk"],
  };
}

export function validateCurrentOnboarding(surface) {
  const { version } = surface;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  for (const name of ["rootReadme", "sdkReadme", "agentGuide", "llms"]) {
    // Only inspect the current introduction. Frozen lab/version evidence further
    // down may legitimately retain its historical pin.
    const firstPin = surface[name].match(/@once-agent\/sdk@(\d+\.\d+\.\d+)/)?.[1];
    assert.equal(firstPin, version, `${name}: current SDK introduction is stale`);
  }
  assert.equal(surface.html.match(/"softwareVersion":\s*"([^"]+)"/)?.[1], version,
    "static homepage metadata must match the published SDK");
  assert.ok(surface.html.includes(`@once-agent/sdk ${version}`), "static CLI badge is stale");
  assert.ok(surface.html.includes(`@once-agent/sdk@${version} once prove`), "first proof pin is stale");
  assert.ok(surface.start.includes(`@once-agent/sdk@${version}`), "start guide is stale");
  assert.ok(surface.recovery.includes(`install \`@once-agent/sdk@${version}\``), "recovery install is stale");
  assert.equal(surface.mcpDependency, version, "reviewed MCP source must pin the current SDK");
  for (const name of ["rootReadme", "sdkReadme", "html"]) {
    assert.doesNotMatch(surface[name], /60[- ]second quick start|Run 60s quickstart/i,
      `${name}: unsupported human onboarding time claim`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateCurrentOnboarding(currentOnboardingSurfaces());
  console.log("Current onboarding surfaces: PASS (historical evidence pins preserved)");
}

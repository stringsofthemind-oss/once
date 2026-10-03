import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const tsPackage = JSON.parse(read("sdk/typescript/package.json"));
const mcpPackage = JSON.parse(read("mcp/package.json"));
const published = JSON.parse(read("docs/published-versions.json"));
const pythonProject = read("sdk/python/pyproject.toml");
const pageAnalytics = read("docs/page-analytics.js");
const homepage = read("docs/index.html");
const app = read("docs/app.js");
const styles = read("docs/styles.css");
const wrangler = read("workers/runtime/wrangler.jsonc");
const runtimeEntry = read("workers/runtime/src/index.js");
const runtimeCore = read("workers/runtime/src/runtime-core.js");
const rootReadme = read("README.md");
const codexLauncher = read("plugins/openai/once/scripts/once-mcp.cjs");
const claudeLauncher = read("plugins/claude-code/once/scripts/once-mcp.cjs");
const codexSkill = read("plugins/openai/once/skills/protect-consequential-writes/SKILL.md");
const codexReadme = read("plugins/openai/once/README.md");
const claudeReadme = read("plugins/claude-code/once/README.md");

const pythonVersion = pythonProject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(pythonVersion, "could not read Python SDK version");

for (const file of ["docs/agent.md", "docs/llms.txt", "docs/GATEWAY.md"]) {
  const current = read(file);
  assert.ok(current.includes(`@once-agent/sdk@${published.ts}`), `${file}: current SDK must match published metadata`);
  assert.doesNotMatch(current, /@once-agent\/sdk@0\.1\.(14|22)\b/, `${file}: obsolete current SDK reference`);
}
assert.match(rootReadme, /Natural Placement[\s\S]*wrapTool/, "root README must expose Natural Placement");
assert.match(homepage, /Natural Placement[\s\S]*wrapTool/, "homepage must expose Natural Placement");

const siteTs = homepage.match(/data-version="ts">([^<]+)/)?.[1];
const sitePython = homepage.match(/data-version="python">([^<]+)/)?.[1];
const siteMcp = homepage.match(/data-version="mcp">([^<]+)/)?.[1];

function patchVersion(value) {
  assert.match(value, /^\d+\.\d+\.\d+$/, "expected a stable published version");
  return value.split(".").map(Number);
}

function sourceAtLeastPublished(source, released) {
  const a = patchVersion(source);
  const b = patchVersion(released);
  return a[0] > b[0] ||
    (a[0] === b[0] && (a[1] > b[1] ||
      (a[1] === b[1] && a[2] >= b[2])));
}

assert.equal(siteTs, published.ts, "homepage TS SDK version must match the published SDK version");
assert.ok(sourceAtLeastPublished(tsPackage.version, published.ts),
  "TS SDK source version must not precede its published version");
assert.equal(sitePython, pythonVersion, "homepage Python SDK version must match sdk/python/pyproject.toml");
assert.equal(siteMcp, published.mcp, "homepage MCP version must match the published MCP version");
assert.ok(sourceAtLeastPublished(mcpPackage.version, published.mcp),
  "MCP source version must not precede its published version");

assert.ok(
  rootReadme.includes(`@once-agent/sdk@${published.ts}`),
  "root README must name the current published TypeScript SDK version",
);
assert.ok(
  rootReadme.includes(`@once-agent/mcp@${published.mcp}`),
  "root README must name the current published MCP version",
);
assert.ok(
  codexLauncher.includes(`@once-agent/mcp@${published.mcp}`),
  "Codex launcher must pin the current published MCP version",
);
assert.ok(
  claudeLauncher.includes(`@once-agent/mcp@${published.mcp}`),
  "Claude Code launcher must pin the current published MCP version",
);
assert.ok(
  codexSkill.includes(`@once-agent/sdk@${published.ts}`),
  "Codex CLI fallback must pin the current published TypeScript SDK version",
);
assert.ok(
  codexReadme.includes(`@once-agent/mcp@${published.mcp}`),
  "Codex plugin README must match the current published MCP version",
);
assert.ok(
  claudeReadme.includes(`@once-agent/mcp@${published.mcp}`),
  "Claude Code plugin README must match the current published MCP version",
);

assert.match(homepage, /Run the retry demo/, "homepage must lead to the ungated demo");
assert.doesNotMatch(homepage, /once-network|Open live proof|Test Once at your scale/, "obsolete proof/funnel claims must stay removed");
const schema = JSON.parse(homepage.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
assert.equal(schema.softwareVersion, published.ts, "static structured metadata must match published SDK");
for (const file of ["docs/index.html", "docs/quickstart/index.html"]) {
  assert.match(read(file), /<!--email_off-->[\s\S]*npm install @once-agent\/sdk@[\s\S]*<!--\/email_off-->/, `${file}: pinned SDK install must opt out of CDN email rewriting`);
  const pins = [...read(file).matchAll(/npm install @once-agent\/sdk@(\d+\.\d+\.\d+)/g)];
  assert.ok(pins.length, `${file}: first-action install must pin a published SDK version`);
  for (const [, version] of pins) {
    assert.equal(version, published.ts, `${file}: first-action install must match the published SDK version`);
  }
}
assert.ok(read("workers/playground/src/index.js").includes("return html(RETRY_DEMO_PAGE)"), "playground root must remain ungated");
assert.match(read("docs/quickstart/index.html"), /Local mode does not automatically redispatch/, "local ambiguity boundary must be explicit");
assert.ok(read("docs/demo/index.html").includes("does not run the SDK"));
assert.match(
  wrangler,
  /"main"\s*:\s*"src\/index\.js"/,
  "runtime wrangler config must keep the guarded src/index.js entrypoint",
);

assert.match(
  runtimeEntry,
  /from\s+"\.\/runtime-core\.js"/,
  "runtime public edge must delegate to the preserved runtime core",
);

assert.match(
  runtimeEntry,
  /PUBLIC_STATS_PATH\s*=\s*"\/v1\/public\/stats"/,
  "runtime public stats route is missing",
);

assert.match(
  runtimeEntry,
  /SELECT COUNT\(\*\) AS protected_operations\s+FROM operations/s,
  "runtime public stats must derive from the durable operations ledger",
);

assert.match(
  runtimeCore,
  /class extends DurableObject|class Q18Truth/,
  "preserved runtime core is missing the Durable Object engine",
);

console.log(`PASS site surface: TS ${siteTs}, Python ${sitePython}, MCP ${siteMcp}; source and safety boundaries aligned`);

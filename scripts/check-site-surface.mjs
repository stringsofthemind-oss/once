import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const tsPackage = JSON.parse(read("sdk/typescript/package.json"));
const mcpPackage = JSON.parse(read("mcp/package.json"));
const pythonProject = read("sdk/python/pyproject.toml");
const pageAnalytics = read("docs/page-analytics.js");
const app = read("docs/app.js");
const styles = read("docs/styles.css");
const wrangler = read("workers/runtime/wrangler.jsonc");
const runtimeEntry = read("workers/runtime/src/index.js");
const runtimeCore = read("workers/runtime/src/runtime-core.js");

const pythonVersion = pythonProject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(pythonVersion, "could not read Python SDK version");

const siteTs = pageAnalytics.match(/ts:\s*"([^"]+)"/)?.[1];
const sitePython = pageAnalytics.match(/python:\s*"([^"]+)"/)?.[1];
const siteMcp = pageAnalytics.match(/mcp:\s*"([^"]+)"/)?.[1];

assert.equal(siteTs, tsPackage.version, "homepage TS SDK version must match sdk/typescript/package.json");
assert.equal(sitePython, pythonVersion, "homepage Python SDK version must match sdk/python/pyproject.toml");
assert.equal(siteMcp, mcpPackage.version, "homepage MCP version must match mcp/package.json");

assert.match(
  pageAnalytics,
  /document\.querySelector\("\.status"\)/,
  "homepage version badge updater is missing",
);

assert.match(
  pageAnalytics,
  /footer > span:last-child/,
  "homepage footer version updater is missing",
);

assert.match(
  pageAnalytics,
  /data\.softwareVersion\s*=\s*SITE_VERSIONS\.ts/,
  "homepage JSON-LD version updater is missing",
);

assert.ok(
  app.includes("https://once-q18-cloud.pennywatch.workers.dev/v1/public/stats"),
  "homepage counter must target the public runtime stats route",
);

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

const heartbeatRule = styles.match(/\.once-network::before\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
assert.match(
  heartbeatRule,
  /animation:\s*once-network-heartbeat\s*1s\s*ease-in-out\s*infinite/s,
  "live network ambient heartbeat must remain a 1-second infinite pulse",
);

assert.match(
  pageAnalytics,
  /heartbeatStyle\.dataset\.onceHeartbeat\s*=\s*"monitor-red-v4"/,
  "red heartbeat monitor override is missing",
);

assert.match(
  pageAnalytics,
  /class\", \"once-heartbeat-monitor\"/,
  "heartbeat monitor SVG is missing",
);

assert.match(
  pageAnalytics,
  /M0 38 H78 L91 38 L101 29 L111 51 L123 8 L135 61 L149 24 L162 38 H300/,
  "heartbeat monitor ECG trace shape is missing",
);

assert.match(
  pageAnalytics,
  /stroke:#ff3040/,
  "heartbeat monitor must retain a bright red trace",
);

assert.match(
  pageAnalytics,
  /once-heartbeat-monitor-sweep\s*1s\s*linear\s*infinite/s,
  "heartbeat monitor sweep must remain exactly one second",
);

const visibleVersionLine =
  `TS SDK ${siteTs} · PY SDK ${sitePython} · MCP ${siteMcp}`;

console.log(
  `PASS site surface: ${visibleVersionLine}; live counter route present; heartbeat=1s red-monitor`,
);
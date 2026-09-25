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
const publicEntry = read("workers/runtime/src/public-entry.js");

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
  /"main"\s*:\s*"src\/public-entry\.js"/,
  "runtime wrangler config must keep the public stats wrapper as its entrypoint",
);

assert.match(
  publicEntry,
  /PUBLIC_STATS_PATH\s*=\s*"\/v1\/public\/stats"/,
  "runtime public stats route is missing",
);

assert.match(
  publicEntry,
  /SELECT COUNT\(\*\) AS protected_operations\s+FROM operations/s,
  "runtime public stats must derive from the durable operations ledger",
);

const heartbeatRule = styles.match(/\.once-network::before\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
assert.match(
  heartbeatRule,
  /animation:\s*once-network-heartbeat\s*1s\s*ease-in-out\s*infinite/s,
  "live network ambient heartbeat must remain a 1-second infinite pulse",
);

const visibleVersionLine =
  `TS SDK ${siteTs} · PY SDK ${sitePython} · MCP ${siteMcp}`;

console.log(
  `PASS site surface: ${visibleVersionLine}; live counter route present; heartbeat=1s`,
);
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const tsPackage = JSON.parse(read("sdk/typescript/package.json"));
const mcpPackage = JSON.parse(read("mcp/package.json"));
const pythonProject = read("sdk/python/pyproject.toml");
const homepage = read("docs/index.html");
const app = read("docs/app.js");
const styles = read("docs/styles.css");
const wrangler = read("workers/runtime/wrangler.jsonc");
const publicEntry = read("workers/runtime/src/public-entry.js");

const pythonVersion = pythonProject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
assert.ok(pythonVersion, "could not read Python SDK version");

const visibleVersionLine = `TS SDK ${tsPackage.version} · PY SDK ${pythonVersion} · MCP ${mcpPackage.version}`;
assert.ok(
  homepage.includes(visibleVersionLine),
  `homepage version badge/footer must match package versions: ${visibleVersionLine}`,
);

assert.ok(
  homepage.includes(`"softwareVersion": "${tsPackage.version}"`),
  "homepage JSON-LD softwareVersion must match the TypeScript SDK package version",
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

console.log(
  `PASS site surface: ${visibleVersionLine}; live counter route present; heartbeat=1s`,
);

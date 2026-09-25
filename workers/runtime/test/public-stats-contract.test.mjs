import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const entry = readFileSync(new URL("../src/public-entry.js", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

function expectSource(pattern, message) {
  assert.match(entry, pattern, message);
}

test("runtime routes through the public stats wrapper", () => {
  assert.match(
    wrangler,
    /"main"\s*:\s*"src\/public-entry\.js"/,
    "wrangler must keep the public stats wrapper as the production entrypoint",
  );
});

test("public stats is GET-only, CORS-safe and no-store", () => {
  expectSource(/PUBLIC_STATS_PATH\s*=\s*"\/v1\/public\/stats"/, "public stats path changed");
  expectSource(/"access-control-allow-origin"\s*:\s*"\*"/, "public stats must be readable by onceexec.com");
  expectSource(/"cache-control"\s*:\s*"no-store"/, "public stats must not be cached as live truth");
  expectSource(/request\.method\s*!==\s*"GET"/, "non-GET public stats requests must be refused");
});

test("public stats reads only aggregate durable ledger state", () => {
  expectSource(/SELECT COUNT\(\*\) AS protected_operations\s+FROM operations/s, "stats must derive from the durable operation ledger");
  assert.doesNotMatch(entry, /operation_id\s*:/, "public stats must not serialize operation identity");
  assert.doesNotMatch(entry, /Authorization|api_key|customer_id/i, "public stats must not expose auth or tenant data");
});

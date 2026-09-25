import { performance } from "node:perf_hooks";

const BASE_URL = "https://api.onceexec.com";
const SAMPLES = 30;
const PAUSE_MS = 100;

const apiKey = process.env.ONCE_API_KEY;

if (!apiKey) {
  throw new Error("ONCE_API_KEY missing");
}

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function percentile(sorted, p) {
  const i = Math.min(
    sorted.length - 1,
    Math.max(
      0,
      Math.ceil((p / 100) * sorted.length) - 1
    )
  );

  return sorted[i];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);

  const mean =
    values.reduce((sum, value) => sum + value, 0) /
    values.length;

  return {
    n: values.length,
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted.at(-1),
  };
}

function printStats(name, s) {
  console.log(`\n${name}`);
  console.log("-".repeat(name.length));
  console.log(`n    : ${s.n}`);
  console.log(`mean : ${s.mean.toFixed(3)} ms`);
  console.log(`p50  : ${s.p50.toFixed(3)} ms`);
  console.log(`p95  : ${s.p95.toFixed(3)} ms`);
  console.log(`p99  : ${s.p99.toFixed(3)} ms`);
  console.log(`min  : ${s.min.toFixed(3)} ms`);
  console.log(`max  : ${s.max.toFixed(3)} ms`);
}

async function execute(operationId) {
  const body = {
    operation_id: operationId,
    provider: "blind_test",
    action: {
      benchmark: "production-warm-latency-v1",
    },
  };

  const start = performance.now();

  const response = await fetch(`${BASE_URL}/v1/execute`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const elapsed = performance.now() - start;

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Non-JSON response HTTP ${response.status}: ${text}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${text}`
    );
  }

  return {
    elapsed,
    json,
  };
}

/*
 * Warm the HTTP/TLS path using the non-mutating root endpoint.
 */
console.log("\n=== HTTP CONNECTION WARMUP ===");

for (let i = 1; i <= 3; i += 1) {
  const start = performance.now();

  const response = await fetch(`${BASE_URL}/`);
  await response.arrayBuffer();

  console.log(
    `warmup ${i}: ${(performance.now() - start).toFixed(3)} ms`
  );

  await sleep(100);
}

console.log("\n=== 30 PAIRED PRODUCTION OPERATIONS ===");

const run =
  `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

const rows = [];

for (let i = 1; i <= SAMPLES; i += 1) {
  const operationId =
    `latency-warm-${run}-${String(i).padStart(2, "0")}`;

  /*
   * Fresh execution.
   */
  const fresh = await execute(operationId);

  if (fresh.json.result !== "executed") {
    throw new Error(
      `Sample ${i}: expected fresh result=executed; ` +
      `got ${JSON.stringify(fresh.json)}`
    );
  }

  if (fresh.json.state !== "CONFIRMED") {
    throw new Error(
      `Sample ${i}: fresh state not CONFIRMED`
    );
  }

  if (fresh.json.side_effects !== 1) {
    throw new Error(
      `Sample ${i}: fresh side_effects != 1`
    );
  }

  await sleep(PAUSE_MS);

  /*
   * Exact replay.
   */
  const replay = await execute(operationId);

  if (replay.json.result !== "already_executed") {
    throw new Error(
      `Sample ${i}: expected replay result=already_executed; ` +
      `got ${JSON.stringify(replay.json)}`
    );
  }

  if (replay.json.state !== "CONFIRMED") {
    throw new Error(
      `Sample ${i}: replay state not CONFIRMED`
    );
  }

  if (replay.json.side_effects !== 1) {
    throw new Error(
      `SAFETY FAILURE sample ${i}: duplicate side effect detected`
    );
  }

  rows.push({
    sample: i,
    operationId,
    freshMs: fresh.elapsed,
    replayMs: replay.elapsed,
    freshAttempts: fresh.json.attempts,
    replayAttempts: replay.json.attempts,
    sideEffects: replay.json.side_effects,
  });

  console.log(
    `${String(i).padStart(2, "0")} | ` +
    `fresh=${fresh.elapsed.toFixed(3)} ms | ` +
    `replay=${replay.elapsed.toFixed(3)} ms | ` +
    `effects=${replay.json.side_effects}`
  );

  await sleep(PAUSE_MS);
}

const freshValues = rows.map(row => row.freshMs);
const replayValues = rows.map(row => row.replayMs);

const freshStats = stats(freshValues);
const replayStats = stats(replayValues);

console.log("\n========================================");
console.log("PRODUCTION WARM-CONNECTION RESULTS");
console.log("========================================");

printStats("Fresh protected execution", freshStats);
printStats("Confirmed duplicate suppression", replayStats);

const saved =
  freshStats.mean - replayStats.mean;

const percent =
  (saved / freshStats.mean) * 100;

console.log("\nReplay advantage");
console.log("----------------");
console.log(`mean delta : ${saved.toFixed(3)} ms`);
console.log(`faster     : ${percent.toFixed(2)}%`);

console.log("\nSafety evidence");
console.log("---------------");
console.log(`HTTP requests       : ${SAMPLES * 2}`);
console.log(`logical operations  : ${SAMPLES}`);
console.log(`expected effects    : ${SAMPLES}`);
console.log(
  `all replays effects=1 : ${
    rows.every(row => row.sideEffects === 1)
  }`
);

if (!rows.every(row => row.sideEffects === 1)) {
  throw new Error(
    "SAFETY FAILURE: at least one replay duplicated an effect"
  );
}

console.log("\nPer-sample results");
console.log("------------------");

console.table(
  rows.map(row => ({
    sample: row.sample,
    fresh_ms: Number(row.freshMs.toFixed(3)),
    replay_ms: Number(row.replayMs.toFixed(3)),
    fresh_attempts: row.freshAttempts,
    replay_attempts: row.replayAttempts,
    side_effects: row.sideEffects,
  }))
);

console.log("\nPHASE 5 BENCHMARK PASSED");
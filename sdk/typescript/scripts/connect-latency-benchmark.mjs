import { performance } from "node:perf_hooks";

import {
  executeConnectOperation,
} from "../dist/connect/execute.js";

import {
  executeConnectWithOnce,
} from "../dist/connect/kernel.js";

const WARMUP = 2_000;
const ITERATIONS = 20_000;

const payload = Object.freeze({
  account_id: "acct_latency_test",
  amount: 1250,
  currency: "GBP",
  metadata: Object.freeze({
    source: "once-connect-latency",
    attempt: 1,
    nested: Object.freeze({
      alpha: true,
      beta: "stable",
      gamma: 42,
    }),
  }),
  items: Object.freeze([
    Object.freeze({
      sku: "sku-001",
      quantity: 2,
      unit_price: 625,
    }),
  ]),
});

const bypassSafety = Object.freeze({
  changesExternalState: false,
  retryPossible: true,
  ambiguousOutcomePossible: false,
  duplicateUndesirable: false,
});

const protectedSafety = Object.freeze({
  changesExternalState: true,
  retryPossible: true,
  ambiguousOutcomePossible: true,
  duplicateUndesirable: true,
});

const action = Object.freeze({
  kind: "latency_probe",
  amount: 1250,
  currency: "GBP",
});

const direct = async () => 1;

const once = Object.freeze({
  async execute() {
    return 1;
  },
});

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;

  const index = Math.min(
    sorted.length - 1,
    Math.max(
      0,
      Math.ceil((p / 100) * sorted.length) - 1,
    ),
  );

  return sorted[index];
}

function summarize(name, samples) {
  const sorted = [...samples].sort((a, b) => a - b);

  const total =
    samples.reduce((sum, value) => sum + value, 0);

  const mean = total / samples.length;

  return {
    name,
    iterations: samples.length,
    mean_us: mean * 1000,
    p50_us: percentile(sorted, 50) * 1000,
    p95_us: percentile(sorted, 95) * 1000,
    p99_us: percentile(sorted, 99) * 1000,
    min_us: sorted[0] * 1000,
    max_us: sorted[sorted.length - 1] * 1000,
    ops_per_second:
      mean > 0 ? 1000 / mean : Infinity,
  };
}

async function measure(name, fn) {
  for (let i = 0; i < WARMUP; i += 1) {
    await fn(i);
  }

  const samples = new Array(ITERATIONS);

  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = performance.now();

    await fn(i);

    samples[i] =
      performance.now() - start;
  }

  return summarize(name, samples);
}

function print(result) {
  console.log("");
  console.log(result.name);
  console.log("-".repeat(result.name.length));
  console.log(`iterations : ${result.iterations}`);
  console.log(`mean       : ${result.mean_us.toFixed(3)} us`);
  console.log(`p50        : ${result.p50_us.toFixed(3)} us`);
  console.log(`p95        : ${result.p95_us.toFixed(3)} us`);
  console.log(`p99        : ${result.p99_us.toFixed(3)} us`);
  console.log(`min        : ${result.min_us.toFixed(3)} us`);
  console.log(`max        : ${result.max_us.toFixed(3)} us`);
  console.log(
    `throughput : ${result.ops_per_second.toFixed(0)} ops/s`,
  );
}

console.log("");
console.log("Once Connect Micro-Latency Benchmark");
console.log("====================================");
console.log(`Node        : ${process.version}`);
console.log(`Platform    : ${process.platform}/${process.arch}`);
console.log(`Warmup      : ${WARMUP}`);
console.log(`Iterations  : ${ITERATIONS}`);
console.log("");
console.log(
  "Measures local orchestration overhead only.",
);
console.log(
  "No provider/network latency is included.",
);

const directResult =
  await measure(
    "Direct async control",
    () => direct(),
  );

const bypassResult =
  await measure(
    "Connect bypass",
    (i) =>
      executeConnectOperation({
        safety: bypassSafety,
        operationId: `bypass-${i}`,
        payload,
        bypass: direct,
      }),
  );

const protectedResult =
  await measure(
    "Connect protected + no-op Once",
    (i) =>
      executeConnectWithOnce({
        once,
        provider: "latency-provider",
        safety: protectedSafety,
        operationId: `protected-${i}`,
        payload,
        action,
      }),
  );

print(directResult);
print(bypassResult);
print(protectedResult);

const bypassTax =
  bypassResult.mean_us -
  directResult.mean_us;

const protectedTax =
  protectedResult.mean_us -
  directResult.mean_us;

console.log("");
console.log("Incremental Once Connect tax");
console.log("----------------------------");

console.log(
  `bypass mean tax    : ${bypassTax.toFixed(3)} us`,
);

console.log(
  `protected mean tax : ${protectedTax.toFixed(3)} us`,
);

console.log(
  `protected p50      : ${protectedResult.p50_us.toFixed(3)} us`,
);

console.log(
  `protected p95      : ${protectedResult.p95_us.toFixed(3)} us`,
);

console.log(
  `protected p99      : ${protectedResult.p99_us.toFixed(3)} us`,
);

console.log("");
console.log("BENCHMARK COMPLETE");

import assert from "node:assert/strict";

import {
  calculateBenchmarkMetrics
} from "../dist/benchmark.js";

const observations = [
  {
    timestamp: "2026-09-20T20:00:00Z",
    resource: "github:repo:example",
    fingerprint: "a"
  },
  {
    timestamp: "2026-09-20T20:01:00Z",
    resource: "github:repo:example",
    fingerprint: "a",
    latency_ms: 120,
    response_bytes: 1000,
    upstream_cost: 0.01,
    once_cost: 0.001,
    once_decision: "UNCHANGED"
  },
  {
    timestamp: "2026-09-20T20:02:00Z",
    resource: "github:repo:example",
    fingerprint: "b",
    latency_ms: 140,
    response_bytes: 1200,
    upstream_cost: 0.01,
    once_cost: 0.001,
    once_decision: "CHANGED"
  }
];

const metrics = calculateBenchmarkMetrics(observations);

assert.equal(metrics.observations, 3);
assert.equal(metrics.unique_resources, 1);
assert.equal(metrics.baseline_observations, 1);
assert.equal(metrics.eligible_repeated_observations, 2);
assert.equal(metrics.unchanged_repeats, 1);
assert.equal(metrics.changed_repeats, 1);
assert.equal(metrics.safely_avoidable_observations, 1);
assert.equal(metrics.avoidance_rate, 0.5);
assert.equal(metrics.change_recall, 1);
assert.equal(metrics.stale_state_errors, 0);
assert.equal(metrics.latency_avoidable_ms, 120);
assert.equal(metrics.response_bytes_avoidable, 1000);
assert.equal(metrics.upstream_cost_avoidable, 0.01);
assert.equal(metrics.once_check_cost, 0.002);
assert.equal(metrics.economic_avoidance_ratio, 5);

console.log("Benchmark regression: PASS");

import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

export type OnceBenchmarkDecision =
  | "BASELINE_CREATED"
  | "UNCHANGED"
  | "CHANGED"
  | "UNKNOWN";

export interface BenchmarkObservation {
  timestamp: string;
  resource: string;
  fingerprint: string;
  latency_ms?: number;
  response_bytes?: number;
  upstream_cost?: number;
  once_cost?: number;
  once_decision?: OnceBenchmarkDecision;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkMetrics {
  observations: number;
  unique_resources: number;
  baseline_observations: number;
  eligible_repeated_observations: number;
  unchanged_repeats: number;
  changed_repeats: number;
  safely_avoidable_observations: number;
  avoidance_rate: number;
  evaluated_once_decisions: number;
  real_changes_with_once_decision: number;
  real_changes_correctly_detected: number;
  change_recall: number | null;
  stale_state_errors: number;
  stale_state_error_rate: number | null;
  latency_avoidable_ms: number;
  response_bytes_avoidable: number;
  upstream_cost_avoidable: number;
  once_check_cost: number;
  economic_avoidance_ratio: number | null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
}

function validateObservation(value: unknown, lineNumber: number): BenchmarkObservation {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid benchmark observation on line ${lineNumber}.`);
  }

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.timestamp !== "string" || candidate.timestamp.length === 0) {
    throw new Error(`Missing timestamp on line ${lineNumber}.`);
  }

  if (typeof candidate.resource !== "string" || candidate.resource.length === 0) {
    throw new Error(`Missing resource on line ${lineNumber}.`);
  }

  if (typeof candidate.fingerprint !== "string" || candidate.fingerprint.length === 0) {
    throw new Error(`Missing fingerprint on line ${lineNumber}.`);
  }

  return candidate as unknown as BenchmarkObservation;
}

export async function appendBenchmarkObservation(
  tracePath: string,
  observation: BenchmarkObservation
): Promise<void> {
  const absolutePath = resolve(tracePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await appendFile(
    absolutePath,
    `${JSON.stringify(observation)}\n`,
    "utf8"
  );
}

export async function readBenchmarkTrace(
  tracePath: string
): Promise<BenchmarkObservation[]> {
  const text = await readFile(resolve(tracePath), "utf8");
  const lines = text
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON on benchmark trace line ${index + 1}.`);
    }
    return validateObservation(parsed, index + 1);
  });
}

export function calculateBenchmarkMetrics(
  observations: BenchmarkObservation[]
): BenchmarkMetrics {
  const previousByResource = new Map<string, BenchmarkObservation>();
  const resources = new Set<string>();

  let baselineObservations = 0;
  let eligibleRepeatedObservations = 0;
  let unchangedRepeats = 0;
  let changedRepeats = 0;
  let safelyAvoidableObservations = 0;
  let evaluatedOnceDecisions = 0;
  let realChangesWithOnceDecision = 0;
  let realChangesCorrectlyDetected = 0;
  let staleStateErrors = 0;
  let latencyAvoidableMs = 0;
  let responseBytesAvoidable = 0;
  let upstreamCostAvoidable = 0;
  let onceCheckCost = 0;

  for (const observation of observations) {
    resources.add(observation.resource);
    const previous = previousByResource.get(observation.resource);

    if (!previous) {
      baselineObservations += 1;
      previousByResource.set(observation.resource, observation);
      continue;
    }

    eligibleRepeatedObservations += 1;
    const actuallyChanged = previous.fingerprint !== observation.fingerprint;

    if (actuallyChanged) {
      changedRepeats += 1;
    } else {
      unchangedRepeats += 1;
    }

    if (observation.once_decision) {
      evaluatedOnceDecisions += 1;
      onceCheckCost += finiteNumber(observation.once_cost);

      if (actuallyChanged) {
        realChangesWithOnceDecision += 1;
        if (observation.once_decision === "CHANGED") {
          realChangesCorrectlyDetected += 1;
        }
        if (observation.once_decision === "UNCHANGED") {
          staleStateErrors += 1;
        }
      } else if (observation.once_decision === "UNCHANGED") {
        safelyAvoidableObservations += 1;
        latencyAvoidableMs += finiteNumber(observation.latency_ms);
        responseBytesAvoidable += finiteNumber(observation.response_bytes);
        upstreamCostAvoidable += finiteNumber(observation.upstream_cost);
      }
    } else if (!actuallyChanged) {
      // Ground-truth upper bound when a shadow Once decision was not recorded.
      safelyAvoidableObservations += 1;
      latencyAvoidableMs += finiteNumber(observation.latency_ms);
      responseBytesAvoidable += finiteNumber(observation.response_bytes);
      upstreamCostAvoidable += finiteNumber(observation.upstream_cost);
    }

    previousByResource.set(observation.resource, observation);
  }

  const avoidanceRate = eligibleRepeatedObservations === 0
    ? 0
    : safelyAvoidableObservations / eligibleRepeatedObservations;

  const changeRecall = realChangesWithOnceDecision === 0
    ? null
    : realChangesCorrectlyDetected / realChangesWithOnceDecision;

  const staleStateErrorRate = evaluatedOnceDecisions === 0
    ? null
    : staleStateErrors / evaluatedOnceDecisions;

  const economicAvoidanceRatio = onceCheckCost > 0
    ? upstreamCostAvoidable / onceCheckCost
    : null;

  return {
    observations: observations.length,
    unique_resources: resources.size,
    baseline_observations: baselineObservations,
    eligible_repeated_observations: eligibleRepeatedObservations,
    unchanged_repeats: unchangedRepeats,
    changed_repeats: changedRepeats,
    safely_avoidable_observations: safelyAvoidableObservations,
    avoidance_rate: avoidanceRate,
    evaluated_once_decisions: evaluatedOnceDecisions,
    real_changes_with_once_decision: realChangesWithOnceDecision,
    real_changes_correctly_detected: realChangesCorrectlyDetected,
    change_recall: changeRecall,
    stale_state_errors: staleStateErrors,
    stale_state_error_rate: staleStateErrorRate,
    latency_avoidable_ms: latencyAvoidableMs,
    response_bytes_avoidable: responseBytesAvoidable,
    upstream_cost_avoidable: upstreamCostAvoidable,
    once_check_cost: onceCheckCost,
    economic_avoidance_ratio: economicAvoidanceRatio
  };
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

export async function runBenchmark(tracePath: string): Promise<BenchmarkMetrics> {
  const observations = await readBenchmarkTrace(tracePath);
  const metrics = calculateBenchmarkMetrics(observations);

  console.log("");
  console.log("Once Benchmark");
  console.log("--------------");
  console.log(`Trace: ${resolve(tracePath)}`);
  console.log(`Observations: ${metrics.observations}`);
  console.log(`Unique resources: ${metrics.unique_resources}`);
  console.log(`Eligible repeated observations: ${metrics.eligible_repeated_observations}`);
  console.log(`Safely avoidable: ${metrics.safely_avoidable_observations}`);
  console.log(`Avoidance rate: ${percent(metrics.avoidance_rate)}`);
  console.log(`Change recall: ${percent(metrics.change_recall)}`);
  console.log(`Stale-state errors: ${metrics.stale_state_errors}`);
  console.log(`Avoidable upstream latency: ${metrics.latency_avoidable_ms.toFixed(0)} ms`);
  console.log(`Avoidable response bytes: ${metrics.response_bytes_avoidable.toFixed(0)}`);
  console.log(`Avoidable upstream cost: ${metrics.upstream_cost_avoidable.toFixed(6)}`);
  console.log(`Once check cost: ${metrics.once_check_cost.toFixed(6)}`);
  console.log(
    `Economic Avoidance Ratio: ${
      metrics.economic_avoidance_ratio === null
        ? "n/a"
        : `${metrics.economic_avoidance_ratio.toFixed(2)}x`
    }`
  );

  return metrics;
}

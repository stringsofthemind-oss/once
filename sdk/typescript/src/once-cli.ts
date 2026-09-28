#!/usr/bin/env node

/**
 * Zero-friction package entry point.
 *
 * Keep the mature CLI implementation in cli.ts as the execution authority.
 * This wrapper only chooses the safest useful default when the user invokes
 * bare `once` / `npx once`.
 *
 * - No arguments + no API key: run local discovery and generate the automatic
 *   protection plan. Do not mutate source or contact the network.
 * - No arguments + ONCE_API_KEY: run the proven Phase 15 protection pipeline,
 *   including transactional apply and route-matched hostile-retry verification.
 * - Any explicit arguments: preserve the existing CLI exactly.
 */

const explicitArgs = process.argv.slice(2);
const zeroFriction = explicitArgs.length === 0;
const startedAt = performance.now();

if (zeroFriction) {
  process.argv.push(
    "doctor",
    ".",
    "--protect"
  );

  if (process.env.ONCE_API_KEY?.trim()) {
    process.argv.push(
      "--apply",
      "--verify"
    );
  }
}

await import("./cli.js");

if (zeroFriction && !process.exitCode) {
  const {
    measureAdoptionMetrics,
    printAdoptionMetrics
  } = await import("./adoption-metrics.js");

  const metrics = await measureAdoptionMetrics(
    ".",
    performance.now() - startedAt
  );

  printAdoptionMetrics(metrics);
}
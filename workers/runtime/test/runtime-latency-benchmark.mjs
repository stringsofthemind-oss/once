import { performance } from 'node:perf_hooks';
import { loadRuntime, storage, execute } from './harness.mjs';

const WARMUP = 250;
const ITERATIONS = 5000;

function percentile(sorted, p) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);

  return {
    iterations: samples.length,
    mean: sum / samples.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1]
  };
}

function printStats(name, result) {
  console.log(`\n${name}`);
  console.log('-'.repeat(name.length));
  console.log(`iterations : ${result.iterations}`);
  console.log(`mean       : ${result.mean.toFixed(3)} ms`);
  console.log(`p50        : ${result.p50.toFixed(3)} ms`);
  console.log(`p95        : ${result.p95.toFixed(3)} ms`);
  console.log(`p99        : ${result.p99.toFixed(3)} ms`);
  console.log(`min        : ${result.min.toFixed(3)} ms`);
  console.log(`max        : ${result.max.toFixed(3)} ms`);
}

async function consume(response) {
  const body = await response.text();

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `unexpected HTTP ${response.status}: ${body.slice(0, 300)}`
    );
  }

  return body;
}

const { Runtime } = await loadRuntime();
const store = storage();
const runtime = new Runtime({ storage: store }, {});

let effects = 0;

/*
 * Credential-free deterministic provider fixture.
 *
 * getProvider returns no prior provider truth for a new operation.
 * executeProvider performs an in-process synthetic effect only.
 *
 * This measures Once runtime/state-machine/SQLite overhead.
 * It does NOT measure Cloudflare network or external-provider latency.
 */
runtime.getProvider = async () => undefined;

runtime.executeProvider = async () => ({
  provider_executed: true,
  side_effects: ++effects
});

console.log('\nOnce Real Runtime Core Latency Benchmark');
console.log('========================================');
console.log(`Node        : ${process.version}`);
console.log(`Platform    : ${process.platform}/${process.arch}`);
console.log(`Warmup      : ${WARMUP}`);
console.log(`Iterations  : ${ITERATIONS}`);
console.log('');
console.log('Checked-in runtime + real SQLite harness.');
console.log('No Cloudflare network/provider network latency included.');

/*
 * Warm the VM/runtime/SQLite path.
 */
for (let i = 0; i < WARMUP; i++) {
  const id = `warmup-${i}`;
  await consume(await execute(runtime, id));
}

/*
 * Fresh execution:
 * unique operation ID each iteration.
 */
const fresh = [];

for (let i = 0; i < ITERATIONS; i++) {
  const id = `bench-fresh-${i}`;

  const start = performance.now();
  const response = await execute(runtime, id);
  await consume(response);
  fresh.push(performance.now() - start);
}

/*
 * Confirmed replay:
 * create one confirmed operation, then repeatedly execute the same ID.
 *
 * executeProvider must not run again.
 */
const replayId = 'bench-confirmed-replay';

await consume(await execute(runtime, replayId));

const effectsBeforeReplay = effects;
const replay = [];

for (let i = 0; i < ITERATIONS; i++) {
  const start = performance.now();
  const response = await execute(runtime, replayId);
  await consume(response);
  replay.push(performance.now() - start);
}

if (effects !== effectsBeforeReplay) {
  throw new Error(
    `SAFETY FAILURE: confirmed replay redispatched provider; ` +
    `before=${effectsBeforeReplay} after=${effects}`
  );
}

const freshStats = stats(fresh);
const replayStats = stats(replay);

printStats('Fresh protected runtime execution', freshStats);
printStats('Confirmed replay / suppression', replayStats);

console.log('\nSafety checks');
console.log('-------------');
console.log(`provider effects total       : ${effects}`);
console.log(`effects during replay window : ${effects - effectsBeforeReplay}`);

console.log('\nInterpretation');
console.log('--------------');
console.log('Fresh = Once state machine + SQLite + synthetic provider effect.');
console.log('Replay = already-confirmed duplicate suppression path.');
console.log('Neither figure includes Cloudflare edge/network/provider RTT.');

console.log('\nRUNTIME BENCHMARK COMPLETE');

store.db.close();
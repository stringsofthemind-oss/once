# Once Phase 6 / Phase 7 Replay Latency Evidence — 2026-09-25

## Result

Phase 7 removed the external provider-truth lookup from the normal confirmed-replay path when the durable Once ledger is `CONFIRMED` and a matching immutable local confirmation receipt exists.

Using the comparable production benchmark method — one Node process, persistent `fetch`, connection reuse, three replay warmups, then 20 measured exact replays — mean replay latency fell from **74.10 ms** in Phase 6 to **50.01 ms** in Phase 7.

| Metric | Phase 6 | Phase 7 | Change |
|---|---:|---:|---:|
| Replay mean | 74.10 ms | 50.01 ms | -24.09 ms |
| Relative reduction | — | — | 32.51% |
| Duplicate external effects | 0 | 0 | no regression |

Phase 7 measured replay distribution:

- p50: 48.55 ms
- p95: 58.72 ms
- p99: 58.72 ms
- min: 41.68 ms
- max: 62.00 ms

## Production identities

- Phase 6 measured production commit: `9cc225e6cda2ce83e67417b5c9dfaf73f9952aed`
- Phase 7 production commit: `f404f9b0f999eb198c408161b6d1f0d4fa605ca1`
- Phase 7 implementation commit: `09e2553c5d20939c88f142c46015eb94fe52a576`
- Phase 7 pull request: `#78`
- Production endpoint: `https://api.onceexec.com/v1/execute`
- Provider used for the comparable benchmark: `blind_test`

## Why Phase 7 was attempted

Temporary Phase 6 `Server-Timing` instrumentation decomposed the replay path and showed that replay server-side time was dominated by the external provider-truth lookup. The Phase 6 replay mean was 74.10 ms end-to-end, with approximately 21.95 ms attributable to provider truth on the measured replay path.

The Phase 7 hypothesis was therefore narrow: remove that external truth round trip only for operations for which Once already has durable local evidence sufficient to suppress execution safely.

## Phase 7 design

Fast replay requires all applicable durable evidence:

1. the operation ledger state is `CONFIRMED`;
2. an immutable local confirmation receipt records exactly one external effect for the same provider; and
3. when HTTP response replay is required, the durable replay envelope also exists.

Receipt absence never grants execution authority. Legacy confirmed operations without a receipt fall through to the existing provider-truth path and can backfill a receipt only after authoritative proof. `UNKNOWN`, `EXECUTING`, fresh, and missing-required-replay cases retain the existing reconciliation / execution-claim behavior.

## Local safety and microbenchmark evidence

Before production deployment, the Phase 7 branch passed:

- 24/24 runtime safety tests;
- the credential-free lost-ack proof with exactly one external effect;
- guarded Worker dry-run;
- a 2,000-sample local replay comparison.

Local replay microbenchmark:

| Metric | Confirmed + receipt | Confirmed + provider truth |
|---|---:|---:|
| mean | 0.198 ms | 0.255 ms |
| p50 | 0.174 ms | 0.221 ms |
| p95 | 0.288 ms | 0.341 ms |
| p99 | 0.684 ms | 1.575 ms |
| min | 0.137 ms | 0.178 ms |
| max | 1.331 ms | 3.637 ms |
| provider-truth calls | 0 | 2000 |
| provider-execute calls | 0 | 0 |

The local saving was 0.058 ms / 22.61%. This local test intentionally did not model the external network RTT; its primary purpose was to prove that the fast path makes zero provider-truth calls and zero provider-execute calls.

## Production safety proof

After guarded deployment of Phase 7:

- a new synthetic operation returned `executed`, `CONFIRMED`, `side_effects=1`;
- its exact replay returned `already_executed`, `CONFIRMED`, `side_effects=1`;
- 20 additional exact replays all returned `already_executed` and remained `CONFIRMED`;
- observed external effects remained exactly 1;
- duplicate external effects remained 0.

A second production operation was then used for the comparable persistent-Node latency benchmark. It produced one fresh external effect, three replay warmups, and 20 measured exact replays, all safe.

## Comparable Phase 7 production samples

Warmups (ms):

`54.62, 59.48, 52.82`

Measured exact replays (ms):

`54.55, 53.06, 58.72, 62.00, 52.36, 44.82, 45.47, 50.87, 44.02, 48.55, 53.45, 47.07, 45.46, 47.59, 48.17, 55.96, 42.46, 52.19, 51.82, 41.68`

The fresh call in this run was 423.42 ms. Phase 7 was designed to optimize confirmed replay, not fresh execution, so that fresh observation is recorded but is not used as evidence of a Phase 7 improvement.

## Non-comparable diagnostic run

Immediately after deployment, a PowerShell loop launched a new `curl.exe` process for each replay. That diagnostic produced:

- mean: 127.21 ms
- p50: 126.15 ms
- p95: 156.05 ms
- p99: 156.05 ms
- min: 107.97 ms
- max: 160.15 ms

This result is retained rather than discarded, but it is **not** used for the Phase 6 / Phase 7 comparison because the client method differs materially from the persistent-Node Phase 6 benchmark. Re-running Phase 7 with one Node process and connection reuse produced the 50.01 ms mean above.

## Interpretation

The measured 24.09 ms reduction closely matches the Phase 6 decomposition that identified the provider-truth RTT as the dominant removable replay cost. The result supports the specific claim that, in this production test, durable local confirmed replay removed that external lookup without increasing observed external effects.

It does not establish a universal latency, SLA, global p95, or guarantee that every provider / client / region will observe the same reduction.

## Limitations

- Single client/network environment.
- Small production sample: 20 measured exact replays per comparable benchmark run.
- Synthetic `blind_test` provider rather than every supported real provider.
- Results are point-in-time observations from 2026-09-25.
- Network, edge routing, geography, congestion, and provider behavior can change independently of Once.
- This evidence demonstrates zero duplicates in the stated tests; it is not a claim of universal exactly-once execution under all possible failures.

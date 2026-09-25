# Phase 9 — Python persistent transport production evidence

Date: 2026-09-25

## Scope

Phase 9 replaces the Python SDK's one-request-per-connection transport with a persistent `urllib3` connection pool while preserving Once-owned network retry behavior, timeout/error mapping, redirect refusal, and public execute/truth semantics.

Implementation commit under test:

`d9bc5a5eb2c80b02ee0cf74aecee806f8562d6a4`

Production endpoint:

`https://api.onceexec.com`

The production proof used the already-confirmed synthetic operation:

`sdk-transport-1790318558325`

No new external effect was created during this Phase 9 production replay benchmark.

## Offline validation

The local Phase 9 validation completed with:

- 8 Python tests run
- 8 passed
- V4 core smoke passed
- execute -> CONFIRMED
- replay -> no second effect
- semantic drift -> OperationConflict
- ambiguous acknowledgement -> UNKNOWN
- reconciliation -> CONFIRMED with one effect
- competing owner -> IN_FLIGHT blocked
- unsafe lease expiry -> re-execution blocked
- `pip check` reported no broken requirements
- repository remained clean

## Production benchmark method

The actual patched Python SDK was installed into an isolated virtual environment from the Phase 9 source tree.

Method:

- 5 warmup exact replays
- 30 measured exact replays
- same already-confirmed operation identity for every request
- provider: `blind_test`
- endpoint: `https://api.onceexec.com`
- `network_retries=0` for the benchmark
- result required: `already_executed`
- state required: `CONFIRMED`
- side effects required: `1`

Warmups (ms):

`192.16, 44.62, 44.44, 45.85, 44.82`

The first warmup includes cold connection establishment and is excluded from the measured replay distribution.

Measured exact replay samples (ms):

`45.82, 43.27, 43.83, 41.50, 47.58, 55.79, 48.80, 42.51, 44.69, 41.40, 43.30, 41.44, 46.28, 59.05, 44.97, 56.46, 45.49, 45.54, 41.10, 41.82, 40.96, 43.24, 41.97, 45.08, 42.99, 43.46, 46.16, 42.09, 41.81, 41.99`

## Result

Actual patched Python SDK replay latency:

- mean: **45.01 ms**
- p50: **43.30 ms**
- p95: **55.79 ms**
- p99: **56.46 ms**
- min: **40.96 ms**
- max: **59.05 ms**

Comparison with the pre-Phase-9 Python SDK measurement:

- original Python mean: **89.27 ms**
- patched Python mean: **45.01 ms**
- absolute saving: **44.26 ms**
- reduction: **49.58%**

A prior in-memory pooling prototype measured **40.19 ms** mean. The separately measured TypeScript SDK baseline was **49.44 ms** mean. Those runs occurred separately and should not be used to claim one language SDK is categorically faster than the other; the supported conclusion is that the Python-specific per-request connection penalty was removed.

## Safety result

- new external effects created: **0**
- duplicate effects observed: **0**
- every measured request returned `already_executed`
- every measured request remained `CONFIRMED`
- every measured response reported `side_effects: 1`
- repository remained unchanged by the production proof

## Interpretation

The Phase 9 production result supports the transport hypothesis established by the earlier SDK comparison: the Python SDK's prior ~89 ms warm replay mean was materially inflated by per-request connection setup. Persistent connection reuse reduced the measured replay mean to ~45 ms without changing Once's exact-once safety state machine or creating any additional external effect.

This is a measurement from one client, route, time window, and Cloudflare path. It is evidence for the observed production path, not a global latency guarantee.

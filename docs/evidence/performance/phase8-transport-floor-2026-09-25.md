# Once Phase 8 Transport-Floor Evidence — 2026-09-25

## Result

Phase 8 measured the warmed production transport floor after the Phase 7 confirmed-replay optimization. The audit made one synthetic fresh operation and then used exact replays only.

| Metric | Custom domain | Direct Worker |
|---|---:|---:|
| Root mean | 28.79 ms | 30.47 ms |
| Replay mean | 47.75 ms | 49.89 ms |
| Replay p50 | 46.54 ms | 48.05 ms |
| Replay p95 | 55.47 ms | 56.86 ms |
| Replay p99 | 64.05 ms | 60.02 ms |

The custom-domain replay path was about 18.96 ms above the custom-domain root baseline in this run. The custom domain did not add measurable overhead relative to the direct workers.dev endpoint; it was slightly faster in both root and replay means for this sample.

All measured persistent-connection requests hit the Cloudflare MAN POP. Replay response-body consumption averaged 0.392 ms, while time to headers averaged 47.36 ms, so the remaining latency is overwhelmingly before response-body consumption.

## Relationship to Phase 7

The comparable Phase 7 production replay mean was 50.01 ms. Phase 8 measured 47.75 ms on the custom domain, a -2.26 ms drift from that recorded mean. This is consistent with the Phase 7 result rather than evidence of a regression.

Phase 6 had measured a replay mean of 74.094 ms and a replay provider-truth HTTPS stage of 21.95 ms. Phase 7 removed that provider-truth network call on durable confirmed replay, producing the observed approximately one-third replay-latency reduction.

## Safety

- Synthetic fresh effects: 1
- Custom-domain exact replays measured: 30
- Direct-Worker exact replays measured: 30
- Duplicate effects observed: 0

No production code was changed and no deployment occurred during Phase 8.

## Method

The primary audit used Node.js `fetch` in one persistent process with five warmups and 30 measured samples per origin. Root `GET /` requests estimated the edge/transport floor. Replay requests used `POST /v1/execute` with one fixed operation identity. Replay-minus-root is an approximate application/Durable Object increment, not a precise causal decomposition.

Supplemental `curl.exe` runs intentionally used fresh connections. Those diagnostics showed substantially higher totals because DNS/TCP/TLS setup was paid repeatedly; they are not directly comparable with the persistent-connection benchmark.

## Raw evidence

The archive `once-phase6-phase8-raw-evidence-2026-09-25.zip` contains the exact uploaded artifacts used for this evidence freeze:

- `Once-Phase8-Transport-Audit-20260925-072902.json`
- `Once-Phase8-Transport-Audit-20260925-072902.txt`
- `Once-Phase6-Hotfix-Proof-20260925-065530.txt`
- `Once-Phase6-Production-Timing-20260925-065530.txt`

See `phase6-phase8-raw-evidence-manifest-2026-09-25.json` for individual SHA-256 values and the archive SHA-256.

## Interpretation and limits

This evidence supports the narrower conclusion that, from the measured UK client path at this time, warmed confirmed replay is close to the observed Cloudflare/transport floor and that the custom domain is not a material latency penalty. It does not establish global latency, every-POP latency, or a universal minimum. Network conditions, geography, connection reuse, Cloudflare routing, and client runtime can materially change end-to-end latency.

The next useful latency question is client behavior rather than further state-machine micro-optimization: verify that official SDKs reuse transport connections effectively, especially the Python SDK.

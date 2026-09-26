# Once Gateway — Phase 12A reference core

This directory contains an **isolated, non-deployed reference implementation** for the Once gateway execution boundary.

It is intentionally small. Phase 12A is about freezing the safety contract before adding hosted transport, billing, arbitrary proxying, or production provider adapters.

## Goal

Move the safety boundary from framework-specific wrappers toward a framework-neutral execution path:

```text
agent / framework
      |
      v
 Once Gateway
      |
      +--> BYPASS harmless work
      |
      +--> PROTECT consequential work
                |
                v
        durable operation state
                |
                v
          provider adapter
                |
                v
       external side effect
                |
                v
          reconciliation
```

## Current decisions

- `BYPASS` — execution is not protected by durable gateway state.
- `EXECUTE` — the protected logical operation was executed and confirmed.
- `REPLAY_CONFIRMED` — the same logical operation was already confirmed; the stored/reconciled result is returned without another effect.
- `BLOCK_UNKNOWN` — the previous attempt may have committed and authoritative truth is unavailable; do not blindly retry.
- `CONFLICT` — the same logical operation identity was reused with a different effect binding.

## Safety rules

1. Logical operation identity is stable across transport retries and framework redispatch.
2. The identity is bound to an `effectHash`; payload drift under the same identity is rejected.
3. A protected execution writes durable `UNKNOWN` state **before** crossing the provider boundary.
4. `CONFIRMED` is replayed without re-execution.
5. `UNKNOWN` must reconcile before another provider execution is permitted.
6. Only `ABSENT` evidence explicitly marked authoritative may permit a new execution attempt.
7. Non-authoritative missing data, a local miss, or an ordinary 404 is not treated as proof of absence.
8. The reference core does not claim universal exactly-once execution.

## Run the isolated tests

```bash
cd workers/gateway
npm test
```

The tests use only Node's built-in test runner and do not contact external services.

## Explicitly not included in Phase 12A

- no production deployment
- no public `/v1/execute` endpoint
- no billing or metering
- no generic arbitrary-HTTP proxy
- no production Stripe adapter
- no secret handling
- no framework release changes

Those belong in later phases after the contract is reviewed.

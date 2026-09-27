# Once Hosted Gateway Production Readiness V1 — Phase 12D

Status: first local/CI implementation slice. **Not deployed. Not wired to the public production `/v1/execute`.**

Phase 12D begins the production-readiness layer around the Phase 12C hosted safety core. The goal is to add commercial admission controls without weakening the execution-safety invariants already proven in staging.

## Scope of this first slice

This slice adds a two-phase hosted admission policy for:

- active entitlement enforcement,
- per-tenant request-rate limiting,
- one-per-logical-operation protected-operation metering,
- monthly quota enforcement for new protected logical operations,
- replay behavior that does not multiply usage across retries or calendar months,
- fail-closed effect-hash binding for a previously reserved logical identity.

The runtime wiring is deliberately opt-in behind the exact environment value:

```text
ONCE_HOSTED_ADMISSION_ENABLED=phase12d
```

No current environment has been changed by this PR. With the flag absent, the merged Phase 12C hosted path behaves as before.

## Required ordering

The hosted request pipeline for a protected operation is:

```text
authenticate tenant
  -> resolve server-owned provider/action registration
  -> validate request schema and protection policy
  -> canonicalise effect-bearing data
  -> derive authoritative effect hash
  -> derive tenant-scoped provider operation key
  -> request admission
       - request-rate limit
       - entitlement/status/plan validation
  -> acquire logical-operation authority
  -> inspect durable operation state
       - effect drift -> semantic CONFLICT
       - CONFIRMED -> REPLAY_CONFIRMED
       - UNKNOWN -> reconcile before any re-execution
  -> deterministic provider adapter preflight
       - missing/corrupt credential fails here
       - no logical-operation meter unit is reserved yet
  -> reserve logical-operation meter identity + quota
  -> durable meter sync
  -> write + sync durable UNKNOWN
  -> provider boundary
```

This ordering is deliberate. An invalid request cannot become billable, a normal effect conflict preserves the Phase 12C semantic `CONFLICT` response, a confirmed replay does not create a new unit, and deterministic provider configuration/credential failure does not consume a protected-operation unit.

Request admission denial occurs before provider adapter construction. Meter reservation occurs only after deterministic preflight proves the adapter is ready for a real provider attempt.

## Metering identity

The target billing identity is one protected logical operation, not one HTTP request:

```text
(tenant_id, operation_id) -> authoritative effect_hash
```

The first accepted effect hash is durably bound to that tenant/logical operation in `hosted_metered_operations`.

Consequences:

- retry of the same operation + same effect: no additional protected-operation unit,
- reconciliation retry: no additional protected-operation unit,
- confirmed replay: no additional protected-operation unit,
- replay in a later calendar month: no additional protected-operation unit,
- same operation ID + changed effect hash after normal durable state exists: Phase 12C semantic `CONFLICT`, no second unit,
- different operation ID: a new logical-operation unit only when it reaches the provider-attempt boundary,
- `BYPASS`: never consumes protected-operation usage.

There is one intentionally conservative crash edge. If a meter reservation is durably flushed and the process fails before the subsequent durable `UNKNOWN` record is written, the meter row still binds that logical operation ID to its first effect hash. A later retry of the same effect continues without another unit. A later attempt to reuse that accepted identity for a different effect fails closed with `operation_effect_conflict` rather than silently changing identity.

## Durable tables introduced by the policy

```text
hosted_metered_operations
  tenant_id
  operation_id
  effect_hash
  first_period_key
  created_at
  PRIMARY KEY (tenant_id, operation_id)

hosted_usage_monthly
  tenant_id
  period_key
  used
  updated_at
  PRIMARY KEY (tenant_id, period_key)

hosted_execute_rate_limits
  tenant_id
  window_key
  request_count
  updated_at
  PRIMARY KEY (tenant_id, window_key)
```

An SQLite `AFTER INSERT` trigger updates the monthly aggregate when and only when a new logical-operation meter row is inserted. This keeps the meter-row creation and aggregate increment in one SQLite statement transaction. `INSERT OR IGNORE` plus a post-insert identity check makes a duplicate reservation idempotent.

A new logical-operation reservation is followed by `storage.sync()` before GatewayCore can write `UNKNOWN` or cross the provider boundary.

## Entitlement source

This first slice reads the existing runtime `stripe_entitlements` table and accepts only:

```text
active
trialing
```

Missing or inactive entitlement fails closed with `403`. Entitlement is checked once at request admission and again at the provider-attempt reservation boundary so a status change during deterministic preflight cannot authorize a stale provider crossing.

The default plan-limit map intentionally mirrors the legacy runtime's current values:

```text
pro      100000
startup  500000
scale   2000000
```

Those defaults are compatibility values, **not a new public pricing commitment**. Phase 12D must separately reconcile commercial plan names/limits before production cutover.

## Rate limiting

Rate limiting is separate from metering.

The first implementation uses a per-tenant fixed one-minute window with a default limit of 120 requests/minute. Retries and replays can consume request-rate capacity because rate limiting protects infrastructure; they do not consume another logical-operation unit.

Authenticated `BYPASS` requests are rate-limited but do not require a protected-operation meter unit. Whether public BYPASS access requires a commercial entitlement remains a product-policy decision before production cutover.

A rate-limit denial is `429` and happens before adapter construction/provider crossing.

## Claim boundary

This slice does **not** claim:

- production hosted billing is enabled,
- the new hosted admission policy is active in staging or production,
- the current commercial pricing table is final,
- public `/v1/execute` cutover is complete,
- Stripe live mode is enabled,
- production credentials are provisioned,
- production deployment has occurred.

It also does not change the core Once claim boundary: Once provides execution-safety semantics under stated assumptions; it does not claim universal exactly-once execution.

## Tests in this slice

The test suite covers:

- request admission runs after authoritative effect binding and before adapter construction,
- request admission denial prevents adapter/provider construction,
- effect-hash mismatch never reaches request admission,
- deterministic adapter preflight failure never reserves a logical-operation unit,
- normal effect drift remains semantic `CONFLICT` and does not reserve another unit,
- missing entitlement fails closed with no meter row,
- inactive entitlement fails closed,
- first logical operation consumes one unit,
- retry/replay does not consume another unit,
- replay in a later month does not consume another unit,
- changed effect hash for an orphaned prior meter reservation fails closed without another unit,
- quota blocks only new operations,
- concurrent distinct operations cannot oversubscribe a one-operation quota while the first meter sync is pending,
- request-rate limiting is independent from logical-operation metering,
- `BYPASS` never consumes protected-operation usage,
- logical-operation reservation crosses `storage.sync()` before execution can continue.

## Next Phase 12D slices

After this foundation is green and reviewed:

1. add explicit end-to-end non-production tests with the opt-in admission gate enabled,
2. add safe response usage/rate headers and audit events,
3. add explicit secret/payload redaction regressions,
4. reconcile final commercial plan names/limits with Stripe entitlements,
5. define production key-version rotation/recovery,
6. hostile-test crash recovery around the meter-sync -> UNKNOWN-sync boundary,
7. design the public `/v1/execute` migration/cutover,
8. keep production deployment and live-provider enablement separately approval-gated.

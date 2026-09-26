# Once Hosted Gateway Production Readiness V1 — Phase 12D

Status: first local/CI implementation slice. **Not deployed. Not wired to the public production `/v1/execute`.**

Phase 12D begins the production-readiness layer around the Phase 12C hosted safety core. The goal is to add commercial admission controls without weakening the execution-safety invariants already proven in staging.

## Scope of this first slice

This slice adds an optional hosted admission hook plus a durable runtime policy for:

- active entitlement enforcement,
- per-tenant request-rate limiting,
- one-per-logical-operation metering,
- monthly quota enforcement for new protected logical operations,
- replay behavior that does not multiply usage across retries or calendar months,
- fail-closed effect-hash conflict detection before a second meter reservation.

It is deliberately **not enabled by default** in the existing Phase 12C runtime binding. That keeps the proven staging path unchanged while the production policy is reviewed and tested.

## Required ordering

The hosted request pipeline for a protected operation is:

```text
authenticate tenant
  -> resolve server-owned provider/action registration
  -> validate request schema and protection policy
  -> canonicalise effect-bearing data
  -> derive authoritative effect hash
  -> derive tenant-scoped provider operation key
  -> Phase 12D admission policy
       - rate limit
       - entitlement
       - logical-operation quota reservation
       - durable meter sync
  -> durable hosted UNKNOWN/CONFIRMED state machine
  -> provider adapter/preflight
  -> provider boundary
```

The admission policy therefore cannot be used to turn an invalid request into a billable operation. Authentication, registered target validation, server-owned protection and authoritative effect binding happen first.

A denied admission cannot construct or invoke the provider adapter.

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
- same operation ID + changed effect hash: conflict, no second unit,
- different operation ID: a new logical-operation unit when admitted,
- `BYPASS`: never consumes protected-operation usage.

This is intentionally stricter than period-scoped request counting. The monthly aggregate records the period in which the logical operation was first admitted.

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

The logical-operation reservation is followed by `storage.sync()` before execution can continue. Provider crossing must not race ahead of the durable usage reservation.

## Entitlement source

This first slice reads the existing runtime `stripe_entitlements` table and accepts only:

```text
active
trialing
```

Missing or inactive entitlement fails closed with `403`.

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

A rate-limit denial is `429` and happens before provider crossing.

## Claim boundary

This slice does **not** claim:

- production hosted billing is enabled,
- the new hosted admission policy is wired to public traffic,
- the current commercial pricing table is final,
- public `/v1/execute` cutover is complete,
- Stripe live mode is enabled,
- production credentials are provisioned,
- production deployment has occurred.

It also does not change the core Once claim boundary: Once provides execution-safety semantics under stated assumptions; it does not claim universal exactly-once execution.

## Tests required in this slice

The test suite covers:

- admission hook runs after authoritative effect binding,
- admission denial prevents adapter/provider construction,
- effect-hash mismatch never reaches admission,
- missing entitlement fails closed with no meter row,
- inactive entitlement fails closed,
- first logical operation consumes one unit,
- retry/replay does not consume another unit,
- replay in a later month does not consume another unit,
- changed effect hash for the same logical operation conflicts without another unit,
- quota blocks only new operations,
- request-rate limiting is independent from logical-operation metering,
- `BYPASS` never consumes protected-operation usage,
- logical-operation reservation crosses `storage.sync()` before admission returns.

## Next Phase 12D slices

After this foundation is green and reviewed:

1. wire the admission policy into a reviewed non-production hosted binding,
2. add safe response usage/rate headers and audit events,
3. add explicit secret/payload redaction regressions,
4. reconcile final commercial plan names/limits with Stripe entitlements,
5. define production key-version rotation/recovery,
6. hostile-test quota boundaries under concurrent multi-operation traffic,
7. design the public `/v1/execute` migration/cutover,
8. keep production deployment and live-provider enablement separately approval-gated.

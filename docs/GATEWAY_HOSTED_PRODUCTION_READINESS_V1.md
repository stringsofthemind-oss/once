# Once Hosted Gateway Production Readiness V1 — Phase 12D

Status: implementation and CI review slice. **Not deployed. Not wired to the public production `/v1/execute`.**

Phase 12D adds production-readiness controls around the merged Phase 12C hosted safety core without weakening its execution-safety invariants.

## Implemented in this slice

This branch now contains:

- state-aware entitlement enforcement for new provider attempts,
- per-tenant request-rate limiting,
- one-per-logical-operation protected-operation metering,
- monthly quota enforcement for new protected logical operations,
- replay behavior that does not multiply usage across retries or calendar months,
- safe confirmed replay and UNKNOWN reconciliation after entitlement lifecycle changes,
- fail-closed effect-hash binding for a previously reserved logical identity,
- allowlisted rate/usage response headers on the internal hosted transport,
- allowlisted server-side admission audit events,
- explicit authorization/payload/metadata redaction regressions,
- hostile recovery tests for the durable meter-sync -> durable UNKNOWN-sync crash window.

The runtime wiring remains deliberately opt-in behind the exact environment value:

```text
ONCE_HOSTED_ADMISSION_ENABLED=phase12d
```

No environment has been changed by this PR. With the flag absent, the merged Phase 12C hosted path behaves as before.

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
       - optional active-plan/current-period usage snapshot
  -> acquire logical-operation authority
  -> inspect durable operation state
       - effect drift -> semantic CONFLICT
       - CONFIRMED -> REPLAY_CONFIRMED
       - UNKNOWN -> reconcile before any re-execution
           - CONFIRMED -> REPLAY_CONFIRMED
           - UNKNOWN -> BLOCK_UNKNOWN
           - authoritative ABSENT -> a new provider attempt may be considered
  -> provider-attempt admission
       - require active/trialing supported entitlement
  -> deterministic provider adapter preflight
       - missing/corrupt credential fails here
       - no new logical-operation meter unit is reserved yet
  -> reserve/reuse logical-operation meter identity + quota
       - re-check active entitlement after preflight
  -> durable meter sync when a new meter unit is created
  -> write + sync durable UNKNOWN
  -> provider boundary
```

This ordering is deliberate. Invalid requests cannot become billable, normal effect drift preserves the Phase 12C semantic `CONFLICT`, confirmed replay does not create a new unit, UNKNOWN can reconcile safely after a subscription changes, and deterministic provider configuration/credential failure does not consume a new protected-operation unit.

A missing or inactive entitlement blocks a **new provider attempt**, not the safety actions needed to replay an already-confirmed result or reconcile a prior UNKNOWN outcome. If UNKNOWN reconciliation is authoritative `ABSENT`, provider-attempt admission runs before preflight/re-execution and fails closed if entitlement is no longer active.

## Metering identity

The billing identity under test is one protected logical operation, not one HTTP request:

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

## Meter-sync -> UNKNOWN-sync crash edge

There is an intentionally conservative two-write boundary between durable meter reservation and the subsequent durable `UNKNOWN` record.

If the process fails after the meter reservation is durably flushed but before `UNKNOWN` is durably written, the meter row survives without a hosted operation record. The branch hostile-tests both recovery paths:

1. retrying the same logical operation with the same authoritative effect reuses the existing meter reservation, creates no second usage unit, then proceeds through the normal UNKNOWN/provider path;
2. attempting to reuse that orphaned logical identity for a different effect fails closed with `operation_effect_conflict` and produces no provider effect.

This proves fail-safe/idempotent recovery behavior for the edge. It does **not** eliminate the commercial fairness question: a durable meter unit can exist even if a crash occurred before the provider attempt and the caller never retries. Refund/adjustment treatment for such an orphan remains a production billing-policy gate.

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

hosted_admission_audit_events
  event_id
  tenant_id
  operation_fingerprint
  event_type
  protection
  plan
  rate_limit
  rate_remaining
  usage_limit
  usage_used
  usage_period
  created_at
```

An SQLite `AFTER INSERT` trigger updates the monthly aggregate when and only when a new logical-operation meter row is inserted. This keeps meter-row creation and aggregate increment in one SQLite statement transaction. `INSERT OR IGNORE` plus a post-insert identity check makes duplicate reservation idempotent.

A new logical-operation reservation is followed by `storage.sync()` before GatewayCore can write `UNKNOWN` or cross the provider boundary.

Audit rows are operational observability only, not billing authority. Their schema is an explicit scalar allowlist. They do not store raw operation IDs, effect hashes, authorization/API-key material, request payloads, free-form metadata, provider operation keys, provider results or credentials. Raw operation IDs are represented only by a tenant-scoped one-way SHA-256 fingerprint for correlation. Audit-retention/cleanup policy remains a production gate.

## Entitlement source and lifecycle semantics

This slice reads the existing runtime `stripe_entitlements` table and treats only these statuses as active for a new provider attempt:

```text
active
trialing
```

The policy intentionally separates three concerns:

1. **Request admission** rate-limits the authenticated tenant and, when an active supported plan is available, may attach a current-period usage snapshot. Missing/inactive entitlement alone does not block this stage.
2. **Provider-attempt admission** runs only after conflict/replay/reconciliation safe exits and requires active/trialing entitlement before adapter preflight.
3. **Meter reservation** re-checks entitlement after deterministic preflight and immediately before a new meter reservation/UNKNOWN/provider boundary.

This prevents a subscription transition from trapping prior safety state. CI explicitly proves:

- an already-confirmed operation can still return `REPLAY_CONFIRMED` after the entitlement becomes inactive, without provider reconstruction or re-execution;
- an existing UNKNOWN operation can still reconcile to `CONFIRMED` after the entitlement becomes inactive, without re-execution;
- if UNKNOWN reconciliation instead returns authoritative `ABSENT`, inactive entitlement blocks the subsequent provider attempt with `403`, the operation remains UNKNOWN, and no second provider effect occurs.

The default plan-limit map intentionally mirrors the legacy runtime's current values:

```text
pro      100000
startup  500000
scale   2000000
```

Those defaults are compatibility values, **not a new public pricing commitment**. Final commercial plan names/limits must be reconciled before production cutover.

Production still needs a defined entitlement-freshness policy: webhook ordering, grace periods, current-period end semantics, delayed/corrupt lifecycle updates and recovery procedures are not settled by this slice.

## Rate limiting

Rate limiting is separate from logical-operation metering.

The current implementation uses a per-tenant fixed one-minute window with a default limit of 120 requests/minute. Retries and replays consume request-rate capacity because rate limiting protects infrastructure; they do not consume another logical-operation unit.

Authenticated `BYPASS` requests are rate-limited but do not consume protected-operation usage. Whether public BYPASS access requires commercial entitlement remains a product-policy decision before production cutover.

Because rate limiting is request-level infrastructure protection, it can temporarily deny even replay/reconciliation requests once a tenant exhausts its request window. That is safe with respect to duplicate execution but is an availability/product-policy consideration before public cutover.

## Internal operational response headers

When the opt-in admission policy is active, successful internal hosted responses may contain only the reviewed operational header set:

```text
x-once-rate-limit-limit
x-once-rate-limit-remaining
x-once-usage-limit
x-once-usage-used
x-once-usage-period
x-once-usage-metered
```

The response body still excludes the internal admission object. The header path accepts only non-negative integer counters and the validated `YYYY-MM` period. It does not copy tenant identity, API keys, payload fields, credentials, provider results or free-form metadata into headers.

`x-once-usage-metered=true` means that request created the new protected logical-operation meter unit. Retry/replay or reuse of an existing meter reservation reports `false`.

## Exact-head CI evidence

Exact reviewed head before this evidence-only documentation commit:

```text
1369b91a0cb0b0a8f83ec32d5109aead9a2f1ab7
```

- Gateway core #100 / run `36282923607`: **PASS**
- Worker CI #446 / run `36282923534`: **PASS**
- runtime suite: **91/91 PASS, 0 failed**
- entitlement lifecycle regressions: **PASS**
- meter-sync -> UNKNOWN-sync hostile recovery regressions: **PASS**
- credential-free lost-ack proof: **PASS / exactly one external effect**

The runtime suite covers, among other existing safety regressions:

- request admission after authoritative effect binding,
- state/conflict/replay/reconciliation handling before provider-attempt entitlement enforcement,
- provider-attempt entitlement denial before lazy adapter preflight/provider crossing,
- deterministic preflight before protected-operation metering,
- semantic conflict and confirmed replay before meter reservation,
- missing/inactive entitlement blocking new provider attempts without blocking safe prior-state recovery,
- confirmed replay after entitlement cancellation without adapter construction,
- UNKNOWN -> CONFIRMED reconciliation after entitlement cancellation without re-execution,
- authoritative ABSENT + inactive entitlement blocking re-execution while preserving UNKNOWN,
- one protected logical operation = one usage unit,
- cross-month retry/replay without duplicate usage,
- quota enforcement and concurrent quota boundary behavior,
- BYPASS rate limiting without protected-operation usage,
- durable meter sync before UNKNOWN/provider crossing,
- internal HTTP execution/replay with one provider effect and one meter unit,
- safe rate/usage header values,
- audit-field allowlisting and raw operation-ID fingerprinting,
- authorization/API-key, payload and free-form metadata redaction,
- same-effect recovery from an orphaned meter reservation without double usage,
- changed-effect failure from an orphaned meter reservation without provider crossing,
- the existing credential-free lost-ack proof with exactly one external effect.

## Claim boundary

This slice does **not** claim:

- production hosted billing is enabled,
- the Phase 12D admission policy is active in staging or production,
- the current commercial pricing table is final,
- public `/v1/execute` cutover is complete,
- Stripe live mode is enabled,
- production credentials are provisioned,
- production deployment has occurred.

It also does not change the core Once claim boundary: Once provides execution-safety semantics under stated assumptions; it does not claim universal exactly-once execution.

## Remaining Phase 12D production gates

1. reconcile final commercial plan names/limits with Stripe entitlements,
2. define production entitlement freshness/lifecycle delivery policy (webhook ordering, grace and stale-state handling),
3. define provider master-key key-version rotation/recovery,
4. define rate-limit, meter and audit retention/cleanup policy,
5. decide commercial treatment of orphaned meter reservations,
6. decide public BYPASS entitlement policy and replay/reconciliation rate-limit policy,
7. design the public `/v1/execute` migration/cutover,
8. keep production deployment separately approval-gated,
9. keep live-provider/live-money enablement separately approval-gated.

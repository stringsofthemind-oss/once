# Once Hosted Gateway Production Readiness V1 — Phase 12D

Status: implementation and CI review slice. **Not deployed. Not wired to the public production `/v1/execute`.**

Phase 12D adds production-readiness controls around the merged Phase 12C hosted safety core without weakening its execution-safety invariants.

## Implemented in this slice

This branch now contains:

- state-aware entitlement enforcement for new provider attempts,
- opt-in entitlement freshness enforcement with fail-closed stale-state handling,
- opt-in monotonic Stripe lifecycle ordering with stale-event suppression and same-second ambiguity handling,
- Stripe-price-authoritative hosted plan identity with metadata unable to override or promote an unknown price,
- a shared hosted Stripe price catalogue covering the current Developer sandbox price plus legacy migration aliases,
- per-tenant request-rate limiting,
- one-per-logical-operation protected-operation metering,
- monthly quota enforcement for new protected logical operations,
- replay behavior that does not multiply usage across retries or calendar months,
- safe confirmed replay and UNKNOWN reconciliation after entitlement lifecycle changes,
- fail-closed effect-hash binding for a previously reserved logical identity,
- allowlisted rate/usage response headers on the internal hosted transport,
- allowlisted server-side admission audit events,
- explicit authorization/payload/metadata redaction regressions,
- hostile recovery tests for the durable meter-sync -> durable UNKNOWN-sync crash window,
- key-version-aware hosted provider credential encryption,
- controlled current/previous provider master-key rotation,
- immutable active-credential rewrap under a new master-key version without returning plaintext credentials,
- explicit-cutoff, bounded cleanup for operational rate-limit and admission-audit rows that never prunes safety or billing authority,
- an approval-gated public `/v1/execute` preview bridge that preserves the existing route unless the exact cutover flag and reviewed lifecycle prerequisites are enabled.

The admission/runtime policy remains deliberately opt-in behind the exact environment value:

```text
ONCE_HOSTED_ADMISSION_ENABLED=phase12d
```

The lifecycle hardening gates are separately opt-in:

```text
ONCE_HOSTED_ENTITLEMENT_FRESHNESS_ENABLED=phase12d
ONCE_HOSTED_ENTITLEMENT_ORDERING_ENABLED=phase12d
```

The public hosted bridge has a separate exact gate:

```text
ONCE_HOSTED_PUBLIC_EXECUTE_ENABLED=phase12d-preview
```

The public preview requires all three reviewed Phase 12D safety gates above. If the preview flag is set while admission, freshness or ordering is missing or near-matched, the bridge fails closed before Durable Object access.

No environment has been changed by this PR. With the public preview flag absent, `/v1/execute` explicitly falls through to the existing runtime route. Merging this code therefore cannot, by itself, cut production execute traffic over to the hosted gateway.

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
       - when enabled, require fresh lifecycle state
  -> deterministic provider adapter preflight
       - missing/corrupt credential fails here
       - no new logical-operation meter unit is reserved yet
  -> reserve/reuse logical-operation meter identity + quota
       - re-check active/fresh entitlement after preflight
  -> durable meter sync when a new meter unit is created
  -> write + sync durable UNKNOWN
  -> provider boundary
```

This ordering is deliberate. Invalid requests cannot become billable, normal effect drift preserves the Phase 12C semantic `CONFLICT`, confirmed replay does not create a new unit, UNKNOWN can reconcile safely after a subscription changes, and deterministic provider configuration/credential failure does not consume a new protected-operation unit.

A missing, inactive, stale, ambiguous or commercially unsupported entitlement blocks a **new provider attempt**, not the safety actions needed to replay an already-confirmed result or reconcile a prior UNKNOWN outcome. If UNKNOWN reconciliation is authoritative `ABSENT`, provider-attempt admission runs before preflight/re-execution and fails closed if the entitlement can no longer authorize a new effect.

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

Audit rows are operational observability only, not billing authority. Their schema is an explicit scalar allowlist. They do not store raw operation IDs, effect hashes, authorization/API-key material, request payloads, free-form metadata, provider operation keys, provider results or credentials. Raw operation IDs are represented only by a tenant-scoped one-way SHA-256 fingerprint for correlation.

## Entitlement source, Stripe price authority and lifecycle semantics

This slice reads the existing runtime `stripe_entitlements` table and treats only these statuses as active for a new provider attempt:

```text
active
trialing
```

The policy intentionally separates three concerns:

1. **Request admission** rate-limits the authenticated tenant and, when an active supported plan is available, may attach a current-period usage snapshot. Missing/inactive entitlement alone does not block this stage.
2. **Provider-attempt admission** runs only after conflict/replay/reconciliation safe exits and requires active/trialing entitlement before adapter preflight. When the freshness gate is enabled, stale lifecycle state also fails closed here.
3. **Meter reservation** re-checks entitlement and freshness after deterministic preflight and immediately before a new meter reservation/UNKNOWN/provider boundary.

This prevents a subscription transition from trapping prior safety state. CI explicitly proves:

- an already-confirmed operation can still return `REPLAY_CONFIRMED` after the entitlement becomes inactive or stale, without provider reconstruction or re-execution;
- an existing UNKNOWN operation can still reconcile to `CONFIRMED` after the entitlement becomes inactive or stale, without re-execution;
- if UNKNOWN reconciliation instead returns authoritative `ABSENT`, an entitlement that is inactive, stale, ambiguous or commercially unsupported blocks the subsequent provider attempt before a new provider effect.

For ordered hosted lifecycle handling, the Stripe subscription item's `price.id` is now the authoritative plan identity. Subscription `metadata.plan` is diagnostic only: it cannot override a known price and cannot turn an unknown/missing price into an entitled plan.

The shared catalogue recognizes the current sandbox Developer Checkout price as `developer` and retains the three older sandbox price IDs as migration aliases for `pro`, `startup` and `scale`. Unknown or missing price IDs resolve to `unknown`.

The default hosted admission limits remain only the legacy compatibility values:

```text
pro      100000
startup  500000
scale   2000000
```

Those values are **migration compatibility, not a new public pricing commitment**. No protected-operation limit is assigned to `developer`, `team` or any future commercial tier by this branch. Therefore the current Developer sandbox price can be identified correctly while still failing closed with `403 entitlement_plan_unsupported` before a new provider attempt until its usage limit is explicitly approved.

This deliberately separates provider-authoritative billing identity from commercial execution authorization. Final public plan names, live Stripe price mappings and per-plan limits remain production approval gates.

The ordered lifecycle path also prevents old Stripe events from overwriting newer state, fails closed on same-created-second ambiguity, and derives accepted `updated_at` from Stripe `event.created` rather than local receipt time. Freshness can independently reject an active-looking entitlement whose lifecycle observation has aged beyond configured bounds.

## Provider master-key versioning and recovery

Hosted provider credentials now have an explicit key-version-aware encryption path. Existing version-1 deployments remain compatible when only the original master-key variable is configured:

```text
ONCE_PROVIDER_MASTER_KEY=<base64 32-byte current key>
ONCE_PROVIDER_MASTER_KEY_VERSION=1   # optional; defaults to 1
```

A controlled rollover can temporarily configure one exact previous version beside the new current version:

```text
ONCE_PROVIDER_MASTER_KEY=<base64 32-byte NEW key>
ONCE_PROVIDER_MASTER_KEY_VERSION=2
ONCE_PROVIDER_PREVIOUS_MASTER_KEY=<base64 32-byte OLD key>
ONCE_PROVIDER_PREVIOUS_MASTER_KEY_VERSION=1
```

The keyring rules are deliberately strict:

- new ciphertext is always encrypted with the configured current key version;
- an existing credential row is decrypted only with the key whose version exactly matches that row's durable `key_version`;
- the runtime never guesses, probes or falls back across arbitrary keys;
- the previous key and previous version must be configured together;
- current and previous versions cannot be equal;
- master keys must decode to exactly 32 bytes;
- a row whose key version is unavailable fails closed with no provider attempt.

The hosted credential admin path adds `rewrap`. Rewrap is **master-key migration, not provider-credential rotation**. It decrypts the active tenant credential with its exact old key version, encrypts the same provider credential under the current key/version, verifies the new ciphertext, creates a new immutable `provider_versions` row and only then moves the active alias. The old encrypted version remains in immutable history. No plaintext provider secret is returned by the admin response.

A production rollover runbook should use this sequence:

1. configure the new current key/version while retaining the old key as the exact previous version;
2. verify reads of existing old-version credentials and writes of new-version credentials;
3. invoke `rewrap` for each active hosted provider credential alias that still references the old version;
4. verify every active alias now resolves to ciphertext carrying the new `key_version`;
5. only then remove the previous key/version configuration;
6. verify old-version active aliases would fail closed rather than silently decrypting with the wrong key.

CI covers old-version read during the overlap window, new-version writes, active credential rewrap, no-op rewrap when already current, successful reads after the previous key is removed once rewrap is complete, fail-closed reads when a required old key is absent, conflicting/incomplete keyring configuration and plaintext non-disclosure.

This branch does **not** automatically rotate any environment secret, bulk-migrate tenants, deploy the keyring, or modify staging/production key material. Actual key rollover remains a separately approval-gated operational event.

## Operational retention mechanism

Phase 12D includes a bounded cleanup primitive for **operational telemetry only**. It deliberately does not choose a retention period and it is not wired to a scheduler or public route.

The cleanup primitive can delete only:

```text
hosted_execute_rate_limits
hosted_admission_audit_events
```

Deletion requires an explicit caller-supplied cutoff. Rate-limit cleanup removes only complete one-minute windows strictly before the minute containing the cutoff. Audit cleanup removes rows whose `created_at` is strictly before its explicit cutoff. Each table is processed in a bounded batch of 1 to 10,000 rows, with 1,000 as the caller default, and the result indicates when another batch may remain. A durable `storage.sync()` follows any deletion.

The cleanup primitive has no implicit destructive default: calling it with no cutoff fails. Invalid timestamps or unsafe batch bounds fail before deletion.

It is deliberately forbidden from pruning billing or execution-safety authority. In particular it never deletes:

```text
hosted_metered_operations
hosted_usage_monthly
hosted_gateway_operations
```

The meter identity and monthly usage ledger therefore remain durable even when short-lived infrastructure rate windows and operational audit telemetry are removed. CI explicitly seeds authority rows, runs cleanup, and verifies those authority rows remain unchanged.

Production still needs policy decisions for the actual rate-limit/audit retention durations, invocation cadence, scheduler/operator ownership, observability for cleanup failures and any eventual archival requirement. No cleanup has been run against staging or production by this branch.

## Public `/v1/execute` preview bridge and cutover boundary

Phase 12D contains the outer public transport needed for a future hosted-gateway cutover, but it is intentionally inert unless an exact separate environment value is configured:

```text
ONCE_HOSTED_PUBLIC_EXECUTE_ENABLED=phase12d-preview
```

The bridge uses a nullable handoff contract. For `/v1/execute` with the gate absent, it returns no response to the outer Worker, which then continues into the pre-existing runtime handler. This makes the compatibility invariant explicit:

```text
merge code + gate absent -> existing /v1/execute behavior
merge code + exact preview gate + exact safety prerequisites -> hosted gateway bridge
```

When preview is requested, the bridge first requires this exact prerequisite stack:

```text
ONCE_HOSTED_ADMISSION_ENABLED=phase12d
ONCE_HOSTED_ENTITLEMENT_FRESHNESS_ENABLED=phase12d
ONCE_HOSTED_ENTITLEMENT_ORDERING_ENABLED=phase12d
```

A missing or near-match prerequisite returns opaque `503 hosted_gateway_unavailable` before Durable Object access.

When the preview gate and prerequisite stack are enabled, the bridge:

- accepts only `POST`,
- enforces the reviewed 64 KiB hosted request-body bound before Durable Object access,
- forwards only `Authorization`, `Content-Type`, a recomputed `Content-Length`, and the body to the synthetic internal hosted endpoint,
- does not forward cookies, arbitrary debug headers or other caller metadata,
- leaves authentication, tenant identity, effect binding, durable state, admission/metering, reconciliation and provider execution inside the authoritative Durable Object,
- maps Durable Object resolution/fetch failures to an opaque `503 hosted_gateway_unavailable`,
- returns `no-store` and `nosniff`,
- forwards only the reviewed content type plus the six allowlisted Once rate/usage headers from the internal response,
- strips arbitrary internal, tenant, provider and `Set-Cookie` response headers.

CI proves that the gate-absent path returns control for legacy fallthrough without resolving the Durable Object, missing/near-match safety prerequisites fail before DO access, unrelated routes are ignored, oversized bodies are rejected before DO access, request forwarding is allowlisted, response metadata is allowlisted and infrastructure failures remain opaque.

This is **not a production cutover**. The branch does not set the preview or safety flags in any environment. Production still needs a separately approved rollout plan covering compatibility/canary scope, monitoring, rollback criteria and the eventual transition from preview gating to the permanent hosted route.

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

## CI evidence

The latest reviewed implementation head before these documentation-only updates is:

```text
d5abc2ff2ee3c9714808af5d947f8fe1723b6006
```

At that implementation head:

- Gateway core #147 / run `36287306161`: **PASS**
- Worker CI #493 / run `36287306159`: **PASS**
- runtime suite: **142/142 PASS, 0 failed**
- Stripe plan-authority regressions: **PASS**
- public hosted preview full-prerequisite regressions: **PASS**
- entitlement freshness and ordered-lifecycle regressions: **PASS**
- operational retention regressions: **PASS**
- provider master-key version/rewrap regressions: **PASS**
- meter-sync -> UNKNOWN-sync hostile recovery regressions: **PASS**
- credential-free lost-ack proof: **PASS / exactly one external effect**
- runtime deployment step: **dry-run only / nothing deployed**

The runtime suite covers, among other existing safety regressions:

- request admission after authoritative effect binding,
- state/conflict/replay/reconciliation handling before provider-attempt entitlement enforcement,
- provider-attempt entitlement denial before lazy adapter preflight/provider crossing,
- deterministic preflight before protected-operation metering,
- semantic conflict and confirmed replay before meter reservation,
- missing/inactive/stale entitlement blocking new provider attempts without blocking safe prior-state recovery,
- confirmed replay after entitlement cancellation without adapter construction,
- UNKNOWN -> CONFIRMED reconciliation after entitlement cancellation/freshness expiry without re-execution,
- authoritative ABSENT + inactive/stale entitlement blocking re-execution while preserving safety state,
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
- exact-version provider master-key selection and fail-closed missing-version behavior,
- immutable hosted credential rewrap under a new current master-key version without plaintext return,
- explicit-cutoff bounded cleanup of operational rate/audit state while preserving authoritative meter/usage state,
- ordered Stripe lifecycle monotonicity and rollback-safe event dedupe,
- provider-authoritative Stripe price mapping with metadata unable to override/promote,
- recognition of the current Developer sandbox price without silently inventing a commercial usage limit,
- unknown/missing Stripe prices failing closed for new provider attempts,
- gate-absent public execute legacy fallthrough and gate-enabled strict hosted transport forwarding,
- the existing credential-free lost-ack proof with exactly one external effect.

## Claim boundary

This slice does **not** claim:

- production hosted billing is enabled,
- the Phase 12D admission policy is active in staging or production,
- entitlement freshness or ordered lifecycle handling is active in staging or production,
- the hosted public execute preview gate is active in staging or production,
- the current commercial pricing/usage table is final,
- public `/v1/execute` cutover has occurred,
- Stripe live mode is enabled,
- production credentials are provisioned,
- production provider master keys were changed,
- any staging/production operational cleanup was run,
- production deployment has occurred.

It also does not change the core Once claim boundary: Once provides execution-safety semantics under stated assumptions; it does not claim universal exactly-once execution.

## Remaining Phase 12D production gates

1. approve final public plan names, live Stripe price mappings and per-plan protected-operation limits,
2. choose production entitlement freshness max-age/grace values and stale/ambiguous-state alert/recovery procedures,
3. define and rehearse the approval-gated operational bulk-check/rollover runbook for provider master-key migration,
4. choose production rate-limit/audit retention durations, cleanup invocation cadence and operational ownership/observability,
5. decide commercial treatment of orphaned meter reservations,
6. decide public BYPASS entitlement policy and replay/reconciliation rate-limit policy,
7. define and approve the `/v1/execute` compatibility/canary/monitoring/rollback rollout plan before enabling the preview gate,
8. keep production deployment separately approval-gated,
9. keep live-provider/live-money enablement separately approval-gated.

# Phase 12D — Hosted Entitlement Lifecycle Safety V1

Status: implementation/CI review only. **Not enabled in staging or production.**

This slice hardens the Stripe subscription state used by hosted admission without changing the existing production webhook path unless exact opt-in gates are configured.

## Goals

The hosted gateway must not start a new consequential provider attempt merely because a locally cached subscription row still looks active when the control-plane state is stale, expired or delivered out of order.

At the same time, subscription problems must not trap execution-safety state that already exists. Confirmed replay and UNKNOWN reconciliation therefore remain earlier than the new-provider-attempt entitlement boundary.

## Freshness gate

Entitlement freshness is separately opt-in:

```text
ONCE_HOSTED_ENTITLEMENT_FRESHNESS_ENABLED=phase12d
ONCE_HOSTED_ENTITLEMENT_MAX_AGE_SECONDS=<positive integer>
ONCE_HOSTED_ENTITLEMENT_PERIOD_END_GRACE_SECONDS=<non-negative integer; optional>
```

When the gate is absent, the existing Phase 12D admission policy is returned unchanged.

When enabled, an `active` or `trialing` entitlement must have trustworthy lifecycle timestamps before a new provider attempt can proceed:

- `updated_at` must parse and must not exceed the reviewed clock-skew allowance,
- `updated_at` must be no older than the configured maximum age,
- `current_period_end` must parse,
- the current time must not exceed `current_period_end + configured grace`.

Failure is closed with `503 entitlement_state_stale`. Missing/inactive entitlement keeps the base `403` semantics instead of being relabeled stale.

Freshness is checked twice:

1. before deterministic provider adapter preflight;
2. again immediately before protected-operation meter reservation.

The second check prevents a long preflight from silently aging an entitlement past the accepted freshness boundary before metering/UNKNOWN/provider crossing.

No production max-age or grace value is selected by this document.

## Ordered Stripe lifecycle gate

Out-of-order Stripe subscription delivery is separately opt-in:

```text
ONCE_HOSTED_ENTITLEMENT_ORDERING_ENABLED=phase12d
```

When the gate is absent, `/stripe/webhook` falls through to the pre-existing signed webhook implementation unchanged.

When enabled, the outer bridge:

- still requires `STRIPE_WEBHOOK_SECRET`,
- verifies the Stripe HMAC signature and timestamp tolerance before Durable Object access,
- parses the signed event,
- forwards only the parsed event JSON to the synthetic internal entitlement endpoint,
- does not forward cookies, Stripe signature material or arbitrary caller/debug headers,
- maps Durable Object resolution/fetch failure to an opaque `503 stripe_webhook_unavailable`.

No network/provider write is performed by this lifecycle processor.

## Durable ordering authority

The ordered path introduces two control-plane tables:

```text
hosted_entitlement_event_order
  customer_id PRIMARY KEY
  latest_event_created
  latest_event_id
  latest_event_type
  ambiguous
  updated_at

hosted_entitlement_lifecycle_events
  event_id PRIMARY KEY
  event_type
  customer_id
  event_created
  outcome
  processed_at
```

`stripe_entitlements` remains the admission-facing entitlement snapshot.

For supported subscription events (`customer.subscription.created`, `.updated`, `.deleted`):

- duplicate event ID -> idempotent replay, no second mutation;
- `event.created` older than the customer's current ordering authority -> durably record `IGNORED_STALE_EVENT`, never overwrite entitlement;
- a distinct event in the exact same Stripe-created second as the current authority -> fail closed as `AMBIGUOUS_SAME_TIMESTAMP`;
- a strictly newer event -> apply and become the new ordering authority.

A same-second ambiguity changes an existing entitlement status to:

```text
lifecycle_ambiguous
```

That status is intentionally not an active entitlement, so admission cannot use an unresolved ordering tie to start a new provider effect. A strictly newer lifecycle event can resolve the ambiguity.

Unsupported Stripe events are durably recorded as ignored and do not mutate entitlement state.

## Safe opt-in and rollback compatibility

The ordering gate can be introduced onto an existing legacy entitlement ledger without assuming that the new ordering table has always existed.

Before a customer has a `hosted_entitlement_event_order` row, an existing `stripe_entitlements.updated_at` is treated as a conservative ordering floor. A first ordered event whose Stripe `event.created` is not strictly newer than that floor is recorded as:

```text
IGNORED_PRE_ORDERING_BASELINE
```

It cannot overwrite the existing entitlement and it does not establish new ordering authority. A strictly newer Stripe lifecycle event can then establish the per-customer ordering record.

The ordered path also cooperates with the pre-existing `stripe_events` ledger in both directions:

- if an event ID is already present in legacy `stripe_events`, the ordered path treats it as `LEGACY_ALREADY_PROCESSED` and does not mutate entitlement again;
- every event durably processed or ignored by the ordered path is also inserted into `stripe_events` with `INSERT OR IGNORE`.

The second rule is deliberate rollback protection. If the ordering gate is later disabled and traffic falls back to the legacy webhook handler, an event already consumed by the ordered path remains a duplicate to the legacy path instead of being applied a second time.

This is migration compatibility, not a claim that the gate has been enabled anywhere. No staging or production lifecycle traffic has been switched by this branch.

## Lifecycle time and freshness interaction

For an accepted ordered event, `stripe_entitlements.updated_at` is derived from Stripe `event.created`, not local receipt time.

This matters because a delayed old event arriving now must not make old control-plane state look freshly observed. The ordering layer prevents it from replacing newer state, and the freshness layer can independently reject an active-looking snapshot whose provider lifecycle timestamp has aged beyond the configured window.

## Stripe price authority and commercial boundary

The ordered hosted entitlement path treats the Stripe subscription item's `price.id` as the authoritative plan identity. Subscription `metadata.plan` is diagnostic only: it cannot override a known purchased price and cannot promote an unknown or missing price into an entitled plan.

The shared hosted plan catalogue currently recognizes:

- the current sandbox Developer Checkout price as `developer`;
- the legacy sandbox `pro`, `startup` and `scale` price IDs for migration compatibility.

An unknown or missing Stripe price is stored as plan `unknown`. A conflicting metadata plan does not change that result.

Phase 12D intentionally does **not** assign a protected-operation limit to the new `developer` plan, nor does it invent final Team/Scale/Enterprise limits. The current admission default contains only the legacy compatibility limits. Therefore an active entitlement carrying the recognized Developer sandbox price still fails closed with `403 entitlement_plan_unsupported` before a new provider attempt until the commercial plan limits are explicitly approved.

This separates two decisions that must not be conflated:

1. **billing identity** — which Stripe price the customer actually purchased;
2. **execution authorization** — which approved usage limit that price is allowed to authorize.

The first is now provider-authoritative. The second remains an explicit production/commercial approval gate.

## Safety ordering

These controls do not move entitlement checks ahead of replay/reconciliation safe exits.

The protected-operation path remains conceptually:

```text
authenticate
  -> authoritative effect binding
  -> request-rate admission
  -> durable operation state
       -> CONFLICT
       -> REPLAY_CONFIRMED
       -> UNKNOWN reconciliation
  -> new-provider-attempt entitlement/freshness admission
  -> deterministic provider preflight
  -> entitlement/freshness re-check
  -> meter reservation + durable sync
  -> durable UNKNOWN + sync
  -> provider boundary
```

Therefore:

- confirmed replay can remain available after cancellation/staleness;
- UNKNOWN may reconcile to CONFIRMED without a new provider attempt;
- authoritative ABSENT reaches the new-provider-attempt boundary and fails closed if the subscription state is inactive, stale, ambiguous or mapped to an unsupported commercial plan.

## Public hosted preview dependency

The approval-gated public `/v1/execute` preview is now deliberately stricter than internal/staging hosted execution.

If `ONCE_HOSTED_PUBLIC_EXECUTE_ENABLED=phase12d-preview` is ever enabled, the public bridge also requires all three reviewed safety gates to be present with their exact values before it resolves the Durable Object:

```text
ONCE_HOSTED_ADMISSION_ENABLED=phase12d
ONCE_HOSTED_ENTITLEMENT_FRESHNESS_ENABLED=phase12d
ONCE_HOSTED_ENTITLEMENT_ORDERING_ENABLED=phase12d
```

Any missing or near-match prerequisite fails closed with an opaque `503 hosted_gateway_unavailable` before Durable Object access. The preview gate itself remains absent from staging and production, so this branch does not cut over public traffic.

The freshness max-age/grace values are still operator-supplied and validated by the hosted admission policy. Enabling the public bridge does not select production timing values or commercial plan limits by itself.

## CI coverage

At implementation head `d5abc2ff2ee3c9714808af5d947f8fe1723b6006`, the runtime suite passed **142/142** with zero failures and the credential-free lost-ack proof still ended with exactly one external effect.

The Phase 12D runtime suite covers:

- freshness gate inert unless exact opt-in value is configured,
- fresh active entitlement admitted,
- stale active entitlement still permits request-level admission but blocks a new provider attempt,
- expired current period blocked,
- explicit period-end grace honored,
- missing/malformed/future lifecycle timestamps blocked,
- inactive entitlement retains base 403 behavior,
- freshness re-check before meter reservation,
- unsafe freshness configuration rejected,
- stale entitlement blocks a new provider effect while confirmed replay remains local,
- UNKNOWN reconciles to CONFIRMED after freshness expiry without re-execution,
- same-second lifecycle ambiguity blocks provider construction/effect,
- older active lifecycle event cannot overwrite newer cancellation,
- duplicate event ID is idempotent,
- ordered events populate the legacy Stripe event ledger for rollback-safe dedupe,
- events already processed by the legacy path are duplicates on first ordered handling,
- an existing legacy entitlement acts as a conservative bootstrap floor until a strictly newer event establishes ordering authority,
- same-created-second distinct events fail closed as ambiguous,
- strictly newer lifecycle event resolves ambiguity,
- accepted `updated_at` derives from Stripe `event.created`,
- unsupported events do not mutate entitlement,
- ordered webhook gate inert unless exact opt-in value is configured,
- invalid signature rejected before Durable Object access,
- verified public webhook forwards only parsed event JSON internally,
- public hosted preview refuses to activate unless admission, freshness and ordering gates are all exact,
- public hosted preview rejects near-match lifecycle gate values before Durable Object access,
- current Developer sandbox Checkout price is sourced from the shared catalogue,
- known Stripe price outranks conflicting metadata,
- unknown/missing Stripe price cannot be promoted by metadata,
- ordered entitlement writes the purchased price-derived plan,
- current Developer sandbox price resolves to `developer` but fails closed because no commercial usage limit has been approved,
- unknown price resolves to `unknown` and fails closed at provider-attempt admission.

Exact-head GitHub Actions for that implementation head were green: Gateway core #147 / run `36287306161` and Worker CI #493 / run `36287306159`. The runtime deploy step was a dry-run only and reported that nothing was deployed.

## Remaining production decisions

This slice deliberately does not choose:

1. final public plan names, live Stripe price mappings or per-plan protected-operation limits,
2. production freshness max-age,
3. production current-period grace,
4. operational alerting/escalation for `lifecycle_ambiguous`,
5. recovery policy if Stripe webhook delivery is unavailable for longer than the freshness window,
6. the staged public `/v1/execute` canary, monitoring and rollback criteria before the already-required lifecycle safety gates are enabled,
7. any production deployment or live-provider/live-money change.

Those remain approval-gated production-readiness decisions.

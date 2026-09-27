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

## Lifecycle time and freshness interaction

For an accepted ordered event, `stripe_entitlements.updated_at` is derived from Stripe `event.created`, not local receipt time.

This matters because a delayed old event arriving now must not make old control-plane state look freshly observed. The ordering layer prevents it from replacing newer state, and the freshness layer can independently reject an active-looking snapshot whose provider lifecycle timestamp has aged beyond the configured window.

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
- authoritative ABSENT reaches the new-provider-attempt boundary and fails closed if the subscription state is inactive, stale or ambiguous.

## CI coverage

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
- older active lifecycle event cannot overwrite newer cancellation,
- duplicate event ID is idempotent,
- same-created-second distinct events fail closed as ambiguous,
- strictly newer lifecycle event resolves ambiguity,
- accepted `updated_at` derives from Stripe `event.created`,
- unsupported events do not mutate entitlement,
- ordered webhook gate inert unless exact opt-in value is configured,
- invalid signature rejected before Durable Object access,
- verified public webhook forwards only parsed event JSON internally.

## Remaining production decisions

This slice deliberately does not choose:

1. production freshness max-age,
2. production current-period grace,
3. operational alerting/escalation for `lifecycle_ambiguous`,
4. recovery policy if Stripe webhook delivery is unavailable for longer than the freshness window,
5. whether ordering and freshness gates must become mandatory prerequisites of public `/v1/execute` cutover,
6. any production deployment or environment change.

Those remain approval-gated production-readiness decisions.

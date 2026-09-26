# Stripe integration TODO

This file is the source of truth for the remaining Stripe Checkout setup.

## Current sandbox configuration

- Product: Once
- Plan: Developer
- Price: GBP 19.00 / month
- Stripe Price ID: `price_1UJyvzAHX5spO4zqEefb2D3I`
- Checkout mode: `subscription`
- Checkout UI: hosted page
- Success URL: `https://onceexec.com/success?session_id={CHECKOUT_SESSION_ID}`
- Cancel URL: `https://onceexec.com/`
- Runtime endpoint: `POST /v1/billing/checkout`

Configured Checkout Studio parameters are implemented in [`workers/runtime/src/stripe-checkout.js`](workers/runtime/src/stripe-checkout.js).

## Values to configure before sandbox execution

No Stripe secret key is committed to this repository.

Configure the runtime secret through the existing deployment secret-management path:

- `STRIPE_SECRET_KEY` — sandbox/test secret key (`sk_test_...`)
- optional `CHECKOUT_ALLOWED_ORIGIN` — defaults to `https://onceexec.com`

Do not place `STRIPE_SECRET_KEY` in source code, a public `.env`, GitHub Pages, or browser JavaScript.

## Site wiring still required

The hosted checkout endpoint returns JSON containing the Checkout Session `id` and Stripe-hosted `url`. The public site still needs a Developer-plan purchase action that:

1. sends `POST` to the deployed runtime `/v1/billing/checkout` endpoint;
2. reads the returned `url`;
3. redirects the browser to that Stripe-hosted URL.

Do not wire or publish the production purchase button until the sandbox runtime endpoint has been deployed and tested deliberately.

## Fulfilment / entitlement still required

A successful browser redirect is not proof of payment and must not grant paid access by itself.

Before production launch, add server-side subscription fulfilment using signed Stripe webhook events (at minimum the appropriate Checkout/subscription lifecycle events), store the relevant Stripe customer/subscription identifiers in the production account model, and make entitlement changes idempotent.

A webhook secret such as `STRIPE_WEBHOOK_SECRET` will be required when that phase is implemented. It is intentionally not added by this checkout-only change.

## Sandbox test checklist

- [ ] Configure `STRIPE_SECRET_KEY` in the sandbox runtime only.
- [ ] Deploy to a non-production/sandbox endpoint with explicit approval.
- [ ] POST to `/v1/billing/checkout` and confirm a `cs_test_...` session is returned.
- [ ] Open the returned hosted Checkout URL.
- [ ] Complete a Stripe test subscription.
- [ ] Confirm redirect to `/success?session_id=...`.
- [ ] Confirm no live Stripe objects or real payments are involved.
- [ ] Add signed webhook fulfilment before enabling real paid access.
- [ ] Replace sandbox Price IDs with live Price IDs only during a separately reviewed live launch.

## Security boundaries

- The server fixes the Price ID; clients cannot submit arbitrary prices.
- The secret key remains server-side.
- Provider error messages are not returned verbatim to callers.
- The success page does not grant entitlement.
- This change does not deploy anything, create a live Stripe charge, publish packages, or switch Stripe out of sandbox mode.

# Phase 12C hosted Stripe staging lost-ack proof — 2026-09-26

This record preserves the successful Phase 12C hosted-gateway staging proof against Stripe sandbox/test mode.

## Exact proof identity

- Workflow: `Phase 12C live Stripe staging proof`
- Run: `36279225398`
- Run URL: https://github.com/stringsofthemind-oss/once/actions/runs/36279225398
- Tested head: `ef441a213aad4da8440becdef735db3c211080c2`
- Branch: `phase12c/hosted-gateway-transport-contract`
- Staging Worker: `once-q18-cloud-staging`
- Worker URL: `https://once-q18-cloud-staging.pennywatch.workers.dev`
- Cloudflare version: `97639c0a-dd81-4d4d-acaa-cbead9b019da`
- Runtime safety suite immediately before provider access: **73 passed / 0 failed**

## Observed provider proof

The workflow created a Stripe test-mode PaymentIntent, then invoked the hosted Once refund path with a narrowly scoped fault injector that allowed Stripe to commit a successful refund before discarding the acknowledgement.

Observed proof record:

```json
{
  "proof": "ONCE_PHASE_12C_HOSTED_STRIPE_STAGING_LOST_ACK",
  "passed": true,
  "tenant": "tenant_phase12c_1790464957_10176",
  "operation_id": "phase12c-staging-lostack-1790464957-19576",
  "payment_intent": "pi_3UK4vSAHX5spO4zq3Rt073Zw",
  "refund_id": "re_3UK4vSAHX5spO4zq3wq6LaIQ",
  "effect_hash": "sha256:81bd875f48cd021855cdef0c9709991ec2492310cc4a59fde3f8b88a120e73b2",
  "first_decision": "BLOCK_UNKNOWN",
  "retry_decision": "REPLAY_CONFIRMED",
  "final_decision": "REPLAY_CONFIRMED",
  "matching_provider_refunds": 1,
  "amount": 100,
  "currency": "gbp",
  "livemode": false,
  "credential_disabled_after_proof": true
}
```

The proof therefore observed the target sequence:

`provider commit -> acknowledgement lost -> BLOCK_UNKNOWN -> provider reconciliation -> REPLAY_CONFIRMED`

The Stripe verification query found exactly one matching refund for the logical operation/effect binding. After that verification, the tenant-scoped Stripe credential was disabled and a final request still returned `REPLAY_CONFIRMED`, demonstrating confirmed replay from durable Once state without requiring the provider credential.

## Artifact

- Artifact ID: `10917754092`
- Name: `phase12c-hosted-stripe-staging-proof`
- ZIP size: `572` bytes
- GitHub artifact digest: `sha256:abd2ef4f59327ebdccd37ed7408ee59c117d12994bb8790921549ef1e27bad7c`
- GitHub retention expiry: `2026-10-26T23:22:41Z`

The machine-readable proof is also frozen beside this note as `phase12c-hosted-stripe-staging-proof-2026-09-26.json` so the result remains reviewable after the temporary Actions artifact expires.

## Scope and limits

This is one adversarial staging proof for `stripe / refund.create` using Stripe sandbox/test mode. It demonstrates the tested hosted path across GitHub Actions, Cloudflare Worker/Durable Object state, encrypted tenant provider credentials, a real Stripe sandbox provider call, injected acknowledgement loss, reconciliation, and durable confirmed replay.

It is not a claim of universal exactly-once execution, does not cover live Stripe or production traffic, and does not establish behavior for providers/actions that were not tested. No live money moved.

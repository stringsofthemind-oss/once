# Bounded Stripe sandbox refund qualification

This host-owned example reuses `protectToolCall` and the existing Stripe refund
adapter, preserving native `once:<operationId>` idempotency keys. It is not a
connector proxy or an installed tool. The profile pins account, preexisting test
PaymentIntent, exact amount (USD 1 in the runner), currency and operation identity.
It checks the account and completed test payment before dispatch. Reconciliation
requires one exact succeeded test refund; pending, failed, duplicates, malformed,
unavailable or incomplete paginated truth remain UNKNOWN. No absence permits a
new write. It never creates charges or payment intents.

Run `npm run build` then `node examples/stripe-sandbox-refund/qualify.mjs` from the
SDK directory only with explicitly authorized host-managed sandbox bindings:

- STRIPE_SANDBOX_SECRET_KEY: existing test key, supplied securely by the host
- STRIPE_SANDBOX_ACCOUNT_ID and STRIPE_SANDBOX_PAYMENT_INTENT: operator-pinned test
  account and completed USD test payment with at least USD 1 available to refund
- ONCE_EXECUTION_DATABASE and ONCE_CONTINUITY_DATABASE: separately authenticated
  verified-TLS PostgreSQL connections in independent restore domains
- ONCE_AUTHORITY_ID, ONCE_AUTHORITY_GENERATION, ONCE_AUTHORITY_EPOCH, ONCE_WITNESS_ID:
  already-provisioned trusted authority/checkpoint identities
- ONCE_QUALIFICATION_OPERATION_ID: explicit stable intent, retained on every retry

No schema or checkpoint is created by this runner. Missing bindings fail before
any provider write. It deliberately drops the acknowledgement only after provider
readback, then reconciles and checks replay/conflict. Independent provider listing
counts the terminal effect. Reruns retain the same operation and never invent an
identity to escape uncertainty. Output contains receipts, never credentials.

The local credential-free profile test is simulation evidence only. Real Stripe
qualification has not been run without a sandbox account/credential binding.
Production, pending refund completion, multiple currencies/accounts, real-money
payments and arbitrary connector interception are outside this profile.

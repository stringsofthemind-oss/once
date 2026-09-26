# Once Hosted Provider Credentials V1 — Phase 12C

Status: implemented locally/CI for the internal hosted gateway. Not deployed.

This note records the credential boundary used by the Phase 12C hosted `stripe / refund.create` registration. It is intentionally narrower than a general secrets service.

## Storage model

Hosted Stripe refund credentials reuse the runtime's existing encrypted provider configuration infrastructure:

- immutable encrypted versions are stored in `provider_versions`,
- the active version is selected by `provider_aliases`,
- the runtime provider master key remains server-side in `ONCE_PROVIDER_MASTER_KEY`,
- provider config encryption uses AES-GCM through the existing runtime crypto helpers,
- a fresh random 12-byte IV is generated for each encrypted version,
- authenticated additional data binds ciphertext to tenant, internal provider alias and immutable version ID.

The hosted Stripe credential alias is an internal namespace (`__once_hosted_stripe_refund`). It begins with an underscore deliberately: the existing public generic provider-registration name grammar requires an alphanumeric first character, so a customer-created HTTP provider cannot collide with this internal alias.

## Tenant isolation

Credential lookup begins with the authenticated tenant ID. The active alias lookup is scoped by:

```text
(customer_id, __once_hosted_stripe_refund)
```

The referenced immutable version is then required to match all of:

```text
version_id
customer_id
provider_name
provider_type = hosted_stripe_refund_v1
```

A forged cross-tenant alias therefore cannot resolve another tenant's version. Even if encrypted bytes were copied into another tenant/version row, the existing AES-GCM additional-data binding would prevent successful decryption under the wrong tenant or version identity.

## Rotation and disable behavior

Credential rotation creates a new immutable encrypted version and atomically moves the tenant alias to that version. Previous encrypted versions remain historical records; they are not rewritten.

Disabling a credential marks the tenant alias disabled. Lookup then returns no usable credential while immutable encrypted history remains intact.

There is no fallback from hosted execution to one global Stripe environment secret.

## Stripe mode restriction

Phase 12C hosted refunds accept only Stripe test-mode secret keys beginning with `sk_test_`.

Live-looking keys, restricted keys and malformed values are rejected before storage or provider access. The Phase 12C provider adapter independently enforces the same test-mode boundary.

## Failure boundary

Credential resolution occurs during adapter preflight, before a new hosted operation writes durable `UNKNOWN`.

Therefore deterministic conditions such as these do not manufacture an ambiguous provider state:

- no credential configured for the authenticated tenant,
- credential alias disabled,
- wrong provider credential type,
- missing provider master key,
- decryption/authentication failure,
- non-test Stripe secret.

If an operation is already `UNKNOWN`, provider credentials are required for reconciliation. Missing or unreadable credentials fail closed; they are never treated as evidence that the Stripe effect is absent.

A previously `CONFIRMED` operation replays from durable state without constructing the provider adapter and therefore does not need the provider secret again.

## Secret exposure rules

Raw Stripe credentials must not be written to:

- hosted operation records,
- API responses,
- logs,
- metrics,
- traces,
- source control,
- PR evidence.

The credential store returns only non-secret metadata from rotation operations. Retrieval returns plaintext only inside the server-side adapter construction path.

## Provisioning boundary

This PR intentionally does **not** add a public Stripe-credential provisioning endpoint.

The encrypted storage/rotation/lookup primitive exists inside the Durable Object runtime, but exposing a provisioning API is a separate security decision because it must define authentication, entitlement, CSRF/origin expectations where applicable, audit behavior, rotation/revocation semantics and response redaction.

A real staging Stripe proof therefore remains gated on an explicitly reviewed way to provision one tenant's `sk_test_...` credential into this encrypted store.

## CI evidence expected

The credential tests verify:

- ciphertext does not contain the plaintext Stripe secret,
- two tenants resolve only their own secret,
- rotation creates a new immutable version,
- disabling an alias fails closed,
- live/restricted/malformed secrets create no credential row,
- forged cross-tenant aliasing cannot resolve another tenant's version,
- missing provider master key fails closed during lookup.

The Worker dry-run also compiles the runtime wiring from the authenticated hosted request through tenant-scoped credential lookup into the Stripe refund registration.

## Staging gates

Before any staging deployment or real Stripe sandbox call through the hosted transport:

1. keep PR #149 review-complete and CI green on the exact head,
2. configure a staging-only 32-byte provider master key as a platform secret,
3. add or approve a narrow tenant-authenticated test-credential provisioning path,
4. provision only an `sk_test_...` Stripe secret for the intended staging tenant,
5. keep the hosted execute transport non-public until its public migration/cutover is separately reviewed,
6. repeat the lost-acknowledgement proof against real Stripe sandbox through the hosted HTTP path,
7. verify one refund POST/effect, reconciliation to `REPLAY_CONFIRMED`, tenant-scoped idempotency and no secret leakage,
8. do not enable live Stripe or production deployment without separate explicit approval.

# Once Hosted Provider Credentials V1 — Phase 12C

Status: implemented and exercised in isolated staging with Stripe sandbox/test mode on 2026-09-26. **Not deployed to production and not enabled for live Stripe.**

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

## Staging-only provisioning boundary

Phase 12C contains a narrow staging-only credential provisioning transport. It is disabled by default outside the isolated staging environment and is not a tenant-facing production API.

The outer Worker route is:

```text
POST /__once/staging/hosted/credentials/stripe-refund
```

The route behaves as `404 not_found` unless the platform configuration contains the exact value:

```text
ONCE_HOSTED_CREDENTIAL_ADMIN_ENABLED=staging
```

When enabled it additionally requires a high-entropy bearer secret supplied through the platform secret:

```text
ONCE_HOSTED_CREDENTIAL_ADMIN_TOKEN
```

The configured token must use the `once_admin_stage_` prefix and satisfy the minimum length check. Authentication is performed without logging or returning the token.

Provisioning accepts only two operations:

```json
{
  "action": "rotate",
  "tenant_id": "<existing hosted tenant>",
  "secret_key": "sk_test_..."
}
```

or:

```json
{
  "action": "disable",
  "tenant_id": "<existing hosted tenant>"
}
```

The tenant must already have an active Once API-key record. This prevents silent creation of orphan credential records from tenant-ID typos.

The outer staging route forwards the request to the same authoritative `Q18Truth` Durable Object over a synthetic internal host. The Durable Object performs encrypted rotation/disable. The outer route reconstructs its response from a strict safe-field allowlist, so even an accidental future internal response containing secret/debug fields is not reflected externally.

The route is capped at 16 KiB, accepts JSON only, returns `cache-control: no-store`, rejects `sk_live_...`, and never returns a stored Stripe secret.

No staging flag, admin token, provider master key or Stripe credential is committed to the repository.

## CI and staging evidence

The credential and staging-admin tests verify:

- ciphertext does not contain the plaintext Stripe secret,
- two tenants resolve only their own secret,
- rotation creates a new immutable version,
- disabling an alias fails closed,
- live/restricted/malformed secrets create no credential row,
- forged cross-tenant aliasing cannot resolve another tenant's version,
- missing provider master key fails closed during lookup,
- the staging route is `404` while disabled,
- unsafe/missing admin-token configuration fails closed,
- wrong admin bearer token cannot provision,
- live-looking Stripe secrets are rejected before Durable Object access,
- unknown tenants cannot receive credentials,
- outward provisioning responses are allowlisted and cannot reflect secret/debug fields.

The Worker dry-run compiles the runtime wiring from the authenticated hosted request through tenant-scoped credential lookup into the Stripe refund registration.

The real staging proof completed successfully on exact implementation head `ef441a213aad4da8440becdef735db3c211080c2` in GitHub Actions run `36279225398`. It provisioned one tenant-scoped encrypted Stripe test credential, executed the lost-ack refund proof, verified exactly one matching Stripe sandbox refund, disabled that tenant credential, and then proved confirmed replay still worked without provider credentials.

Frozen evidence:

- `docs/evidence/gateway/phase12c-hosted-stripe-staging-proof-2026-09-26.md`
- `docs/evidence/gateway/phase12c-hosted-stripe-staging-proof-2026-09-26.json`

## Remaining production gates

Before production/public hosted credential use:

1. keep the staging/admin route isolated from production,
2. define provider master-key multi-version rotation and recovery,
3. review a production credential provisioning/rotation/revocation API separately,
4. wire production entitlement, metering and rate-limit policy into the hosted execution path,
5. complete audit-safe hosted observability and secret-redaction regression coverage,
6. improve Stripe reconciliation pagination/liveness as appropriate,
7. repeat adversarial staging tests after any material credential/runtime change,
8. obtain separate explicit approval before any production deployment or live Stripe enablement.

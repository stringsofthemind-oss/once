# Once Hosted Gateway Transport V1 — Phase 12C

Status: contract plus local/CI hosted implementation. **Not deployed.** The new hosted execution path is internal-only and is not a public production endpoint.

Phase 12C moves the Phase 12A safety state machine and Phase 12B Stripe reconciliation proof behind a tenant-scoped, durable, framework-neutral transport without weakening their safety rules.

## Target architecture

```text
agent / framework / MCP client
          |
          v
   future POST /v1/execute
          |
          v
       Once Gateway
          |
          +--> authenticate tenant
          +--> resolve server-owned provider/action policy
          +--> canonicalise effect-bearing data
          +--> derive authoritative effect binding
          +--> acquire serialized operation authority
          +--> write + flush durable safety state
          +--> resolve tenant-scoped provider credential
          +--> invoke registered provider adapter
          +--> reconcile ambiguous outcomes
          +--> meter one logical protected operation   [not yet wired]
          +--> emit audit-safe observability           [not yet complete]
          |
          v
    external provider
```

Current branch implementation is deliberately narrower:

```text
POST https://q18.internal/__once/hosted/v1/execute
```

That route exists only inside the `Q18Truth` Durable Object. The outer Worker does **not** expose it publicly. This avoids creating a second competing public `/v1/execute` while migration/cutover is still under review.

## Normative trust-boundary rules

1. **The server decides `PROTECT` vs `BYPASS`.** A client cannot downgrade a consequential registered action.
2. **The server derives the authoritative effect binding.** Client `effect_hash`, when supplied, is only a consistency assertion and must match exactly.
3. **Provider, action and binding version are part of effect identity.** Reusing one logical operation ID for a different effect is `CONFLICT`.
4. **Canonicalisation is versioned and persisted.** Historical records preserve the binding version used when accepted.
5. **Provider-native idempotency is tenant-scoped.** It derives from tenant + logical operation + provider/action, not raw `operation_id` alone.
6. **`UNKNOWN` is never permission to retry blindly.** Only authoritative provider reconciliation may resolve it.
7. **Deterministic configuration failures occur before the crash boundary.** Credential/schema failures must not create a new durable `UNKNOWN`.
8. **Durable `UNKNOWN` is written and flushed before provider dispatch.** A provider mutation cannot begin while the durability barrier is pending.
9. **Confirmed replay does not require provider credentials.** Durable confirmed state is replayed before adapter construction/preflight.
10. **Server-owned durable record context wins over record/client data.** Tenant, provider, action, binding version and provider operation key cannot be overwritten by a record payload.
11. **Generic HTTP status is not provider truth.** A timeout/5xx/storage failure never implies the external effect is absent.
12. **No arbitrary proxy surface.** V1 accepts only explicitly registered provider/action pairs.

## Hosted request contract

Future public shape:

```http
POST /v1/execute
Authorization: Bearer <once_api_key>
Content-Type: application/json
```

Current local/CI proof uses the same request body through the internal `q18.internal` route.

Example for the only hosted provider/action currently registered:

```json
{
  "operation_id": "refund:customer_123:order_456:v1",
  "target": {
    "provider": "stripe",
    "action": "refund.create"
  },
  "payload": {
    "payment_intent": "pi_...",
    "amount": 2500
  },
  "metadata": {
    "framework": "openai-agents",
    "client_version": "0.1.x"
  }
}
```

`amount` is optional and is expressed in the PaymentIntent currency's minor unit. Currency is not accepted as an independent refund effect field in this V1 schema because Stripe refunds inherit the PaymentIntent currency.

### Request fields

- `operation_id` — required stable logical identity, reused for every retry/redispatch of the same intended effect.
- `target.provider` — required registered provider identifier.
- `target.action` — required registered action identifier.
- `payload` — required provider/action-specific input validated by the registration.
- `effect_hash` — optional client consistency value; the server-derived value remains authoritative.
- `metadata` — optional non-authoritative client context. It cannot replace server-owned hosted metadata.
- `protection` — if accepted for compatibility, it must equal the server registration; it cannot alter policy.

Operation IDs are validated and bounded. Request bodies are bounded to 64 KiB on the internal transport.

## Response semantics

A valid semantic result is HTTP `200`. HTTP success does not mean a new external action ran; clients must obey `decision`.

### New execution confirmed

```json
{
  "decision": "EXECUTE",
  "state": "CONFIRMED",
  "operation_id": "refund:customer_123:order_456:v1",
  "result": {
    "providerReference": "re_..."
  }
}
```

### Confirmed replay or reconciliation

```json
{
  "decision": "REPLAY_CONFIRMED",
  "state": "CONFIRMED",
  "operation_id": "refund:customer_123:order_456:v1",
  "result": {
    "providerReference": "re_..."
  }
}
```

### Ambiguous outcome unresolved

```json
{
  "decision": "BLOCK_UNKNOWN",
  "state": "UNKNOWN",
  "operation_id": "refund:customer_123:order_456:v1"
}
```

The client must not evade `BLOCK_UNKNOWN` by inventing another logical identity for the same intended effect.

### Effect conflict

```json
{
  "decision": "CONFLICT",
  "state": "CONFIRMED",
  "operation_id": "refund:customer_123:order_456:v1",
  "error": {
    "code": "operation_effect_conflict"
  }
}
```

The returned state is the stored state and may be `UNKNOWN` or `CONFIRMED`. No provider mutation occurs on `CONFLICT`.

## HTTP transport policy

- `200` — semantic Once result (`EXECUTE`, `REPLAY_CONFIRMED`, `BLOCK_UNKNOWN`, `CONFLICT`, or server-approved `BYPASS`).
- `400` — malformed JSON/schema, invalid operation ID, effect-hash mismatch, protection-policy mismatch.
- `401` — missing/invalid/revoked Once API key.
- `403` — reserved for authenticated authorization/entitlement denial when that layer is wired.
- `404` — unknown registered provider/action. This is never provider-absence evidence.
- `405` — wrong method.
- `413` — request body exceeds configured limit.
- `415` — unsupported media type.
- `429` — reserved for tenant rate/usage limits when the hosted metering layer is wired.
- `5xx` — infrastructure/configuration failure without a safe semantic result. Retry with the same logical identity.

Unexpected internal errors are returned opaquely; provider/master-key diagnostic text is not exposed.

## Authentication and tenant isolation

The hosted path reuses the runtime `api_keys` table. Raw Once API keys are hashed before lookup. Authentication resolves exactly one server-owned tenant before operation state or provider credentials are accessed.

Durable logical operation identity is:

```text
(tenant_id, operation_id)
```

Two tenants may use the same `operation_id` independently.

The server derives a separate opaque provider operation key equivalent to:

```text
H(tenant_id, operation_id, provider, action)
```

For Stripe hosted refunds it is represented as:

```text
once_hv1_<sha256>
```

The raw tenant ID and raw operation ID are not embedded in that Stripe idempotency key.

## Server-derived effect binding

Each registration defines an exact canonicaliser over effect-bearing fields. V1 hashes a domain-separated representation containing:

```text
provider
+ action
+ binding_version
+ canonical_effect_payload
```

The current Stripe refund binding version is:

```text
stripe-refund-v1
```

The accepted canonical Stripe effect is exactly:

```json
{
  "payment_intent": "pi_...",
  "amount": 2500
}
```

with `amount` optional. Additional payload fields are rejected rather than silently ignored.

## Durable state and serialization

Hosted operation records are stored in the same SQLite-backed Durable Object as the existing runtime. Safety-critical fields are duplicated into typed SQL columns and cross-checked against the stored JSON record on read.

Each protected record preserves at least:

- tenant ID
- operation ID
- server-derived effect hash
- state (`UNKNOWN` / `CONFIRMED`)
- provider
- action
- binding version
- tenant-scoped provider operation key
- safe provider reference when known
- confirmed replay result
- created/updated timestamps

Serialized authority is per tenant-scoped logical operation within the Durable Object instance.

Critically, every hosted safety-state write executes a storage durability barrier. The new `UNKNOWN` write must complete `storage.sync()` before provider dispatch is allowed. A sync failure blocks dispatch and leaves the operation fail-closed.

## Stripe refund registration

Only one hosted consequential provider route exists in this Phase 12C branch:

```text
stripe / refund.create
```

It is always `PROTECT` and reuses the Phase 12B `StripeRefundAdapter`.

Execution:

```text
POST /v1/refunds
```

The Stripe request includes:

- PaymentIntent
- optional refund amount
- Once logical operation metadata
- Once effect-hash metadata
- tenant-scoped Stripe `Idempotency-Key`

Reconciliation queries refunds for the target PaymentIntent and requires matching operation identity, effect hash, PaymentIntent and amount when supplied.

A matching refund is `CONFIRMED`. Missing/non-authoritative/incomplete provider evidence remains `UNKNOWN`; it is not converted into `ABSENT`.

Current liveness limitation: reconciliation examines a bounded Stripe refund listing. If a match is not visible in the inspected page, Once remains safely `UNKNOWN`. Pagination can improve liveness before production without weakening the absence rule.

## Tenant-scoped provider credentials

Hosted Stripe execution does not read a single global Stripe secret.

Credential storage is described in `GATEWAY_HOSTED_CREDENTIALS_V1.md`. In summary:

- encrypted immutable versions use the existing runtime `provider_versions` table,
- active versions use `provider_aliases`,
- the internal alias is `__once_hosted_stripe_refund`,
- encryption reuses the runtime AES-GCM provider-config crypto,
- ciphertext is authenticated against tenant + internal alias + immutable version ID,
- only `sk_test_...` credentials are accepted,
- rotation creates a new immutable encrypted version,
- disabling the alias fails closed,
- there is no global hosted Stripe-secret fallback,
- raw provider credentials do not enter operation state or HTTP results.

Credential lookup happens during adapter preflight before a new `UNKNOWN` is written. Missing/corrupt/unreadable credentials return an opaque `provider_credentials_unavailable` error before provider dispatch.

For an operation already in `UNKNOWN`, credentials are needed for reconciliation. Credential failure leaves the operation blocked; it is never absence evidence.

## Reconciliation rules

Provider adapters follow:

```text
execute(context)   -> confirmed result OR ambiguous error
reconcile(context) -> CONFIRMED | authoritative ABSENT | UNKNOWN
```

Only `ABSENT` with `authoritative: true` can authorize another provider attempt for an existing `UNKNOWN` operation.

These are **not** authoritative absence by themselves:

- local cache/state miss
- ordinary 404
- failed provider read
- partial provider listing
- visibility delay
- missing credential
- timeout
- 5xx

## Metering contract and current status

The intended billing unit is one accepted unique protected logical operation, not one HTTP attempt.

Target rule:

```text
one (tenant_id, operation_id, effect_hash) = one protected-operation unit
```

Retries, reconciliation reads, `REPLAY_CONFIRMED` and duplicate deliveries must not multiply usage. `BYPASS` must not consume protected-operation quota. `CONFLICT` must not create a second unit.

**Current Phase 12C branch does not yet wire this metering/entitlement/rate-limit layer into the new internal hosted transport.** The existing legacy runtime has usage/entitlement primitives, but they are not treated as proof that the new hosted contract is complete. This is a production/public-exposure gate, not hidden as completed work.

## Observability and secret handling

Safe internal observability may include tenant reference/digest, operation reference/digest, effect-hash fingerprint, provider/action, decision, state transition, reconciliation flag, provider reference and latency.

Never log or persist in ordinary operation telemetry:

- raw Once API keys
- Stripe/provider secret keys
- full Authorization headers
- card/payment credentials
- arbitrary request payloads by default
- secret-bearing provider responses

The current hosted implementation does not add secret-bearing logs.

## Current local/CI evidence

The branch contains deterministic tests for:

- API-key authentication
- tenant isolation
- server-owned protection policy
- server-derived binding
- provider/action/binding drift conflict
- concurrent duplicate delivery
- confirmed replay without provider credentials
- durable `UNKNOWN` restart behavior
- provider-truth outage -> `BLOCK_UNKNOWN`
- durable record corruption checks
- durability barrier before provider dispatch
- durability failure blocks provider dispatch
- transport schema/method/media/body limits
- opaque post-boundary infrastructure errors
- Stripe tenant-scoped idempotency
- Stripe fake-provider lost-acknowledgement reconciliation through HTTP
- encrypted tenant-scoped Stripe credential storage
- credential rotation/disable behavior
- cross-tenant credential tamper resistance
- missing master key fail-closed behavior
- opaque credential-store failure before durable `UNKNOWN`

The hosted Stripe HTTP proof currently uses a deterministic Stripe test double. The independent Phase 12B proof against real Stripe sandbox was completed earlier; a **real Stripe sandbox proof through the new Phase 12C hosted transport remains pending**.

## Current non-goals / not-yet-complete items

Phase 12C does not currently claim:

- a new public hosted `/v1/execute` endpoint
- production deployment
- live-mode Stripe
- general arbitrary HTTP proxying
- arbitrary MCP URL execution
- universal exactly-once execution
- public hosted Stripe credential provisioning
- completed hosted billing/metering/entitlement enforcement
- complete hosted audit/observability layer
- provider master-key rotation across multiple key versions
- multi-provider transactions
- distributed transactions

## Staging gates

Before a staging-only deployment/proof:

1. exact PR head remains green under Gateway core + Worker CI + runtime dry-run,
2. final hostile review has no unresolved safety blocker,
3. configure a staging-only 32-byte provider master key as a platform secret,
4. separately review/approve a narrow way to provision one tenant's `sk_test_...` credential,
5. keep the hosted execution route internal or expose only a deliberate staging bridge; do not create a competing production `/v1/execute`,
6. run the real Stripe sandbox lost-ack proof through the hosted HTTP stack,
7. verify one refund effect, tenant-scoped idempotency, reconciliation to `REPLAY_CONFIRMED`, and no credential leakage.

Staging deployment and real provider writes remain separately approval-gated.

## Production/public-exposure gates

Before treating Phase 12C as a commercial public hosted gateway:

1. choose and review the migration/cutover from the existing public runtime `/v1/execute`,
2. wire tenant entitlement, logical-operation metering and rate limits into the hosted path,
3. add audit-safe hosted observability and explicit secret-redaction regression coverage,
4. complete real Stripe sandbox hosted proof,
5. improve Stripe reconciliation pagination/liveness as appropriate,
6. define provider master-key rotation/recovery procedure,
7. review credential provisioning/rotation/revocation APIs,
8. repeat concurrency/crash/adversarial tests in staging,
9. obtain separate explicit approval for any production deployment or live-provider enablement.

## Acceptance criteria

Phase 12C is complete only when all applicable hosted criteria are demonstrated:

1. authenticated tenant-scoped transport exists in non-production/staging first,
2. server owns protection policy,
3. server recomputes effect binding,
4. durable multi-request state is used,
5. `UNKNOWN` is flushed before provider crossing,
6. concurrent identical deliveries produce at most one provider effect under adapter assumptions,
7. changed effect/provider/action returns `CONFLICT`,
8. confirmed operation replays without another provider call,
9. ambiguous outcome persists `UNKNOWN` and reconciles before re-execution,
10. unavailable provider truth returns `BLOCK_UNKNOWN`,
11. tenant A cannot read/replay/affect tenant B state or credentials,
12. provider-native idempotency cannot collide merely because two tenants reuse an operation ID,
13. live-looking credentials are rejected in sandbox/staging,
14. Stripe sandbox lost-ack proof passes through the hosted transport,
15. retry storms do not multiply logical-operation metering,
16. logs contain no raw Once/provider secrets,
17. CI covers auth, tenant isolation, binding, concurrency, durability and adversarial retries,
18. no production deployment or live-money enablement occurs without separate explicit approval.

Phase 12C is a hosted transport safety proof first and a commercial production service second. Safety semantics must survive the move from local reference code to a networked multi-request boundary.

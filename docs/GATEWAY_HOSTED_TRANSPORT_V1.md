# Once Hosted Gateway Transport V1 — Phase 12C

Status: contract + first local/CI implementation slice. Not deployed.

Phase 12C turns the proven gateway semantics into a hosted, framework-neutral transport without weakening the safety guarantees established in Phases 12A and 12B.

## Goal

Expose one narrow hosted execution boundary for consequential operations:

```text
agent / framework / MCP client
          |
          v
     POST /v1/execute
          |
          v
       Once Gateway
          |
          +--> authenticate tenant
          +--> resolve registered provider/action policy
          +--> server-canonicalise effect-bearing data
          +--> derive authoritative effect binding
          +--> acquire serialized operation authority
          +--> read/write durable tenant-scoped state
          +--> invoke registered provider adapter
          +--> reconcile ambiguous outcomes
          +--> meter one logical protected operation
          +--> emit audit-safe observability
          |
          v
    external provider
```

The transport is deliberately thin. It must not change the Phase 12A safety state machine or the provider-reconciliation rules proven in Phase 12B.

## Hostile-review hardening decisions

The hosted boundary is a trust boundary. The following rules are normative:

1. **The server, not the client, decides whether a registered action is `PROTECT` or `BYPASS`.** A client cannot downgrade a consequential registered action by sending `BYPASS`.
2. **The server recomputes the effect binding from the validated registered provider/action schema.** A client-supplied `effect_hash` is optional verification input only; if supplied it must exactly match the server-derived binding.
3. **Provider and action identity are part of the effect binding.** Reusing one logical operation ID for a different provider/action is a conflict even if payload fields are otherwise identical.
4. **Canonicalisation is versioned and persisted.** Provider/action registrations declare a binding version so later schema changes cannot silently reinterpret historical operation identities.
5. **Provider-native idempotency is tenant-scoped.** A native idempotency key must derive from tenant + logical operation + provider/action, not from raw `operation_id` alone. Two tenants may legitimately use the same logical operation ID.
6. **`CONFLICT` reports the stored state.** It must not assume the prior state is `CONFIRMED`; an existing operation may still be `UNKNOWN`.
7. **Billing begins only after auth, authorization, schema validation, target resolution and binding validation succeed.** Rejected malformed/unauthorized requests do not consume a protected-operation unit.
8. **A provider crossing can never be inferred from a generic HTTP status.** If infrastructure fails after durable `UNKNOWN` is written, retries reuse the same identity and reconcile.
9. **The existing repository already contains an evaluation/runtime `/v1/execute` path and tenant/API-key primitives.** Phase 12C should harden/reuse compatible pieces rather than accidentally publish a second conflicting execution plane.

## V1 endpoint

```http
POST /v1/execute
Authorization: Bearer <once_api_key>
Content-Type: application/json
```

V1 exposes only registered provider/action pairs. It is **not** an arbitrary outbound HTTP proxy.

### Request

```json
{
  "operation_id": "refund:customer_123:order_456:v1",
  "effect_hash": "sha256:optional-client-verification-value",
  "target": {
    "provider": "stripe",
    "action": "refund.create"
  },
  "payload": {
    "payment_intent": "pi_...",
    "amount": 2500,
    "currency": "gbp"
  },
  "metadata": {
    "framework": "openai-agents",
    "client_version": "0.1.x"
  }
}
```

### Fields

- `operation_id`: required stable logical operation identity reused across retries, redispatches, reconnects and fresh processes for the same intended effect.
- `effect_hash`: optional client verification value. If present it must equal the server-derived binding exactly. The server binding is authoritative.
- `target.provider`: required registered provider identifier.
- `target.action`: required registered action identifier.
- `payload`: required provider/action-specific data validated by the registered adapter.
- `metadata`: optional non-authoritative client context. It must never override server-owned auth, tenant, provider policy, idempotency or binding metadata.

A client-supplied `protection` field, if accepted for compatibility, must match the server registration. It cannot change server policy.

## Response contract

Successful HTTP transport does not imply the external action executed. Clients must obey the returned Once decision.

### Newly executed and confirmed

```json
{
  "decision": "EXECUTE",
  "state": "CONFIRMED",
  "operation_id": "refund:customer_123:order_456:v1",
  "result": {
    "provider_reference": "re_..."
  }
}
```

### Previously confirmed or reconciled

```json
{
  "decision": "REPLAY_CONFIRMED",
  "state": "CONFIRMED",
  "operation_id": "refund:customer_123:order_456:v1",
  "result": {
    "provider_reference": "re_..."
  }
}
```

### Ambiguous outcome remains unresolved

```json
{
  "decision": "BLOCK_UNKNOWN",
  "state": "UNKNOWN",
  "operation_id": "refund:customer_123:order_456:v1"
}
```

The client must not bypass `BLOCK_UNKNOWN` by inventing a new logical identity for the same intended effect.

### Effect-binding conflict

```json
{
  "decision": "CONFLICT",
  "state": "UNKNOWN",
  "operation_id": "refund:customer_123:order_456:v1",
  "error": {
    "code": "operation_effect_conflict"
  }
}
```

The example state is illustrative. The response returns the stored state, which may be `UNKNOWN` or `CONFIRMED`.

`CONFLICT` means the same tenant-scoped logical identity was presented with a different server-derived effect binding. No provider mutation is permitted.

### Bypass

`BYPASS` is available only for server-registered harmless routes. A client does not get to classify a consequential provider action as harmless.

```json
{
  "decision": "BYPASS",
  "state": null,
  "operation_id": "search:example"
}
```

`BYPASS` must not create protected durable operation state or consume protected-operation quota.

## HTTP status policy

HTTP status communicates transport/auth/request validity. Once decisions communicate execution safety state.

- `200` — valid request processed; decision may be `EXECUTE`, `REPLAY_CONFIRMED`, `BLOCK_UNKNOWN`, `CONFLICT`, or server-authorized `BYPASS`.
- `400` — malformed JSON, invalid schema, client effect-hash mismatch, or protection-policy mismatch.
- `401` — missing/invalid/revoked API key.
- `403` — authenticated tenant is not permitted to use the provider/action or plan feature.
- `404` — unknown registered provider/action route. This is never evidence that an external effect is absent.
- `413` — request body exceeds configured limit.
- `429` — tenant rate limit or logical-operation quota exceeded before provider crossing.
- `5xx` — gateway infrastructure failed before a safe semantic response could be returned. Clients retry with the **same** logical identity and never assume whether the provider action happened.

## Authentication and tenant isolation

V1 uses server-issued Once API keys. Raw provider secrets must not be sent in each execution request.

Each authenticated request resolves exactly one server-owned `tenant_id` before operation state is accessed. The tenant is never accepted from request JSON.

The durable operation identity is:

```text
(tenant_id, operation_id)
```

Two tenants using the same `operation_id` are independent.

API-key requirements:

- raw keys are shown only at creation/rotation time,
- only high-entropy server-issued keys are accepted,
- storage uses non-reversible verifier material,
- revoked keys fail authentication before operation access,
- auth failures do not reveal whether an operation exists,
- raw keys and Authorization headers never enter logs.

Provider credentials are tenant-scoped and server-side. They must never appear in logs, metrics, traces, public responses, or operation-state records.

## Server-derived effect binding

Each provider/action registration defines a canonicaliser over exactly the fields that can change the real-world effect.

The server derives a binding equivalent to:

```text
SHA256(
  binding-domain ||
  provider ||
  action ||
  binding-version ||
  canonical-effect-payload
)
```

The canonicaliser must reject ambiguous/coercible inputs rather than silently normalize unsafe differences.

The registration stores a `binding_version`. Historical operation records preserve the version used when first accepted.

If a client sends `effect_hash`, the server compares it to the derived value before durable state or provider execution. A mismatch is a request error, not a new logical operation.

## Durable state and serialized authority

The hosted implementation replaces the Phase 12A in-memory reference store with durable serialized state suitable for concurrent multi-request access.

For each protected operation, preserve at least:

- `tenant_id`
- `operation_id`
- server-derived `effect_hash`
- `binding_version`
- `state` (`UNKNOWN` or `CONFIRMED`)
- registered `provider`
- registered `action`
- provider-native operation/idempotency key material or safe reference
- provider reference when known
- confirmed result material needed for replay
- first-attempt timestamp
- last-attempt timestamp
- reconciliation timestamp when applicable

Serialized authority is per `(tenant_id, operation_id)`. Concurrent identical deliveries must not race across the provider boundary.

`UNKNOWN` must be durably committed before the provider boundary is crossed.

The first implementation slice may use an injected durable key-value backend plus a single-writer authority abstraction in CI. Production/staging wiring must guarantee that the authority and durable record share one serialization domain; process-local locks alone are insufficient across independently active hosts.

## Provider-native idempotency namespace

Provider-native idempotency complements Once and must not create cross-tenant collisions.

A hosted provider key should be derived from server-owned scope, for example:

```text
provider_key = H(tenant_id, operation_id, provider, action)
```

The raw tenant ID does not need to be exposed to the provider if a cryptographic digest is used.

The Phase 12B Stripe adapter may retain its local single-tenant fallback, but hosted calls must supply the tenant-scoped provider operation key.

## Provider registry

V1 executes only allowlisted adapters registered in code/configuration, for example:

```text
stripe / refund.create
```

Each registration defines:

- request schema
- server protection policy (`PROTECT` or explicitly harmless `BYPASS`)
- effect-bearing fields
- canonicalisation + `binding_version`
- provider-native idempotency behavior
- execution method
- reconciliation method
- whether authoritative `ABSENT` is possible
- secret requirements
- safe result fields for persistence/replay

No client-controlled URL, hostname, arbitrary method, arbitrary header set, or arbitrary provider secret may turn the gateway into a generic SSRF/proxy surface.

## Reconciliation rules

Phase 12B semantics remain unchanged:

```text
execute(context) -> confirmed result OR ambiguous error
reconcile(context) -> CONFIRMED | authoritative ABSENT | UNKNOWN
```

`UNKNOWN` is never permission to execute again.

A provider adapter permits a new provider attempt only after `ABSENT` with `authoritative: true` for the same server-derived logical effect under documented provider consistency semantics.

Missing local state, cache misses, ordinary 404s, partial listings, failed provider reads, and visibility uncertainty are not authoritative absence.

## Metering contract

Billing/metering is based on logical protected operations, not raw HTTP attempts.

One accepted unique protected `(tenant_id, operation_id, effect_hash)` consumes one protected-operation unit **after** auth, authorization, provider/action resolution, schema validation and effect-binding validation succeed.

Retries, `REPLAY_CONFIRMED`, reconciliation reads, duplicate deliveries and safe replays do not multiply usage.

`BYPASS` does not consume protected-operation quota.

`CONFLICT` does not create a second unit for the same operation identity.

Metering derives from durable logical-operation records, not request counters, so transport retry storms cannot inflate usage.

## Observability and audit

Each request may emit safe internal fields such as:

- request/trace ID
- non-secret tenant reference
- operation ID or safe digest
- effect-hash fingerprint
- binding version
- provider/action
- decision
- prior/new durable state
- whether reconciliation ran
- safe provider reference
- latency buckets
- timestamp

Never log:

- Once API keys
- provider secret keys/tokens
- full Authorization headers
- card/payment credentials
- arbitrary payloads by default
- secret-bearing provider responses

Provider payload logging must be opt-in, field-allowlisted and redacted.

## Rate limiting and abuse controls

Rate limiting should happen before expensive provider work where possible while preserving retry safety.

Limits are tenant-scoped. A rate-limit response must not mutate protected state unless execution authority had already been acquired and the provider boundary may have been crossed.

Reject oversized requests, malformed schemas and unsupported provider/action pairs before provider execution.

## Secret lifecycle

Provider credential creation, rotation and revocation are separate from `/v1/execute`.

Minimum requirements:

- encrypted at rest
- never returned after initial submission
- never included in source control, client SDK examples or logs
- scoped to tenant/provider
- rotation does not mutate existing logical operation identity
- revocation fails closed for protected operations that require reconciliation

## Thin client contract

Clients should:

1. create/reuse the stable logical operation ID,
2. optionally compute the expected canonical effect hash as a consistency check,
3. call `/v1/execute`,
4. preserve the same identity across retries,
5. obey the returned decision,
6. never convert `BLOCK_UNKNOWN` into a fresh execution identity.

Clients do **not** decide the authoritative effect binding or protection policy and do not reimplement the durable state machine.

## Existing runtime integration note

The repository already contains a runtime/evaluation `/v1/execute` path with API-key hashing, tenant-scoped operation IDs, usage records, rate limiting, provider credential encryption and durable SQL state.

Phase 12C should treat those as reusable implementation evidence, not as proof that this V1 contract is already complete. In particular, the new gateway contract requires server-owned provider/action policy, server-derived binding compatible with the Phase 12A/12B gateway core, hosted tenant-scoped provider idempotency, and the exact `EXECUTE / REPLAY_CONFIRMED / BLOCK_UNKNOWN / CONFLICT` semantics.

Do not expose a second competing public `/v1/execute` route. The migration/adapter plan must be explicit before staging.

## V1 non-goals

Phase 12C V1 does **not** include:

- arbitrary HTTP proxying
- arbitrary MCP server execution through user-supplied URLs
- universal exactly-once claims
- live-mode Stripe enablement by default
- automatic migration of existing local Once state
- multi-provider transaction atomicity
- distributed transactions across providers
- automatic entitlement based solely on browser redirects
- client-side provider secret storage

## Acceptance criteria

Phase 12C is not complete until all are demonstrated:

1. authenticated tenant-scoped `/v1/execute` transport exists in non-production/staging first,
2. server, not client, owns protection policy,
3. server recomputes and validates the effect binding,
4. durable multi-request operation state replaces the reference in-memory store,
5. concurrent identical deliveries produce at most one provider effect under adapter assumptions,
6. same logical identity with a different provider/action or effect binding returns `CONFLICT`,
7. confirmed operations replay without a second provider call,
8. ambiguous outcome persists `UNKNOWN` and retries reconcile before re-execution,
9. provider truth unavailable returns `BLOCK_UNKNOWN`,
10. Stripe sandbox lost-ack proof passes through the hosted transport,
11. tenant A cannot read/replay/affect tenant B operation state,
12. provider-native idempotency keys cannot collide merely because two tenants reuse an operation ID,
13. live-looking provider credentials are rejected in sandbox/staging,
14. retry storms do not multiply logical-operation metering,
15. logs contain no raw Once/provider secrets,
16. CI contains deterministic auth/tenant-isolation/binding/concurrency/adversarial retry tests,
17. no production deployment or live-money enablement occurs without separate explicit approval.

## Phase sequence

Recommended implementation order:

1. freeze and hostile-review this contract,
2. add auth + tenant-scoped store/authority abstraction and tests,
3. wire a real durable single-writer backend in the existing runtime/gateway hosting plane,
4. add provider registry + server canonicalisation,
5. wire the proven Stripe refund adapter with hosted tenant-scoped provider idempotency,
6. add metering and audit-safe observability,
7. run hostile retry/concurrency tests locally,
8. deploy to staging only after review,
9. repeat the real Stripe sandbox lost-ack proof through the hosted endpoint,
10. only then consider production deployment, billing entitlement and additional providers.

Phase 12C is a hosted transport proof first and a commercial production service second. The safety semantics must survive the move from local reference code to a networked multi-request boundary.

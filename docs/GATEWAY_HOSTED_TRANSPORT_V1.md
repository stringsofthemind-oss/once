# Once Hosted Gateway Transport V1 — Phase 12C

Status: design contract only. Not deployed.

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
          +--> validate logical identity + effect binding
          +--> acquire serialized operation authority
          +--> read/write durable operation state
          +--> invoke registered provider adapter
          +--> reconcile ambiguous outcomes
          +--> meter one logical protected operation
          +--> emit audit-safe observability
          |
          v
    external provider
```

The transport is deliberately thin. It must not change the Phase 12A safety state machine or the provider-reconciliation rules proven in Phase 12B.

## V1 endpoint

```http
POST /v1/execute
Authorization: Bearer <once_api_key>
Content-Type: application/json
```

The V1 hosted gateway exposes only registered provider/action pairs. It is **not** an arbitrary outbound HTTP proxy.

### Request

```json
{
  "operation_id": "refund:customer_123:order_456:v1",
  "effect_hash": "sha256:...",
  "protection": "PROTECT",
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

### Required fields

- `operation_id`: stable logical operation identity reused across retries, redispatches, reconnects and fresh processes for the same intended effect.
- `effect_hash`: deterministic binding over the effect-bearing request fields for the registered action.
- `protection`: `PROTECT` or `BYPASS`. Hosted provider actions that can mutate external state default to `PROTECT`; `BYPASS` is permitted only for explicitly supported harmless paths.
- `target.provider`: registered provider identifier.
- `target.action`: registered action identifier.
- `payload`: provider/action-specific data validated by the registered adapter.

`metadata` is optional and must never participate in the external effect unless a provider adapter explicitly defines a metadata field as effect-bearing.

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
  "state": "CONFIRMED",
  "operation_id": "refund:customer_123:order_456:v1",
  "error": {
    "code": "operation_effect_conflict"
  }
}
```

`CONFLICT` means the same logical identity was presented with a different effect binding. No provider mutation is permitted.

### Bypass

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

Suggested V1 mapping:

- `200` — valid request processed; decision may be `EXECUTE`, `REPLAY_CONFIRMED`, `BLOCK_UNKNOWN`, `CONFLICT`, or `BYPASS`.
- `400` — malformed JSON or invalid schema.
- `401` — missing/invalid API key.
- `403` — authenticated tenant is not permitted to use the provider/action or plan feature.
- `404` — unknown registered provider/action route. This is never evidence that an external effect is absent.
- `409` — reserved for transport-level request conflicts only; Phase 12C should prefer `200` + `decision: CONFLICT` for semantic operation conflicts so clients have one stable decision contract.
- `413` — request body exceeds configured limit.
- `429` — tenant rate limit exceeded before provider execution authority is acquired.
- `5xx` — gateway infrastructure failed before a safe semantic decision could be returned. Clients must retry with the **same** `operation_id` and `effect_hash`; they must not assume the provider action did or did not happen.

## Authentication and tenant isolation

V1 uses server-issued Once API keys. Raw provider secrets must not be sent in each execution request.

Each authenticated request resolves exactly one `tenant_id` before durable operation state is accessed.

The durable operation key is scoped by tenant:

```text
(tenant_id, operation_id)
```

The same `operation_id` used by two tenants must be completely independent.

Provider credentials are also tenant-scoped and stored server-side. They must never appear in logs, metrics, traces, public responses, or operation-state records.

API keys must be stored only as non-reversible verifier material where practical; raw keys are shown only at creation/rotation time.

## Durable state requirements

The hosted implementation replaces the Phase 12A in-memory reference store with durable serialized state suitable for concurrent multi-request access.

For each protected logical operation, storage must preserve at least:

- `tenant_id`
- `operation_id`
- `effect_hash`
- `state` (`UNKNOWN` or `CONFIRMED`)
- registered `provider`
- registered `action`
- provider reference when known
- confirmed result material needed for replay
- first-attempt timestamp
- last-attempt timestamp
- reconciliation timestamp when applicable

The implementation must provide serialized execution authority per `(tenant_id, operation_id)` so concurrent deliveries cannot race into duplicate provider effects.

`UNKNOWN` must be durable before crossing the provider boundary.

## Provider registry

V1 executes only allowlisted adapters registered in code/configuration, for example:

```text
stripe / refund.create
```

Each registration defines:

- request schema
- effect-bearing fields
- effect-hash/canonicalisation rules
- provider-native idempotency behavior
- execution method
- reconciliation method
- whether authoritative `ABSENT` is possible
- secret requirements
- result fields safe to persist/replay

No client-controlled URL, hostname, arbitrary method, arbitrary header set, or arbitrary provider secret may be used to turn the gateway into a generic SSRF/proxy surface.

## Reconciliation rules

Phase 12B semantics remain unchanged:

```text
execute(context) -> confirmed result OR ambiguous error
reconcile(context) -> CONFIRMED | authoritative ABSENT | UNKNOWN
```

`UNKNOWN` is never permission to execute again.

A provider adapter may permit a new provider attempt only after returning `ABSENT` with `authoritative: true` for the same logical effect under documented provider consistency semantics.

Missing local state, cache misses, ordinary 404s, partial listings, failed provider reads, and visibility uncertainty are not authoritative absence.

## Metering contract

Billing/metering is based on logical protected operations, not raw HTTP attempts.

V1 metering rule:

```text
one unique protected logical operation accepted for a tenant = one protected-operation unit
```

Retries, `REPLAY_CONFIRMED`, reconciliation reads, duplicate deliveries and safe replays for the same `(tenant_id, operation_id, effect_hash)` must not multiply protected-operation usage.

`BYPASS` does not consume protected-operation quota.

`CONFLICT` must not create a second protected-operation unit for the same operation identity.

Metering must be derived from durable logical-operation records, not request counters, so transport retry storms cannot inflate usage.

## Observability and audit

Each request should emit an internal event containing safe identifiers only:

- request/trace ID
- tenant ID or non-sensitive internal tenant reference
- operation ID
- effect-hash fingerprint
- provider/action
- decision
- prior/new durable state
- whether reconciliation ran
- provider reference if safe
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

## Latency target

The hosted layer should add minimal overhead to ordinary confirmed/replay paths.

Initial engineering target, to be measured rather than claimed:

- durable replay path should avoid provider calls entirely
- auth + durable lookup + decision overhead should be small relative to normal provider network latency
- reconciliation latency is provider-dependent and must be reported separately from pure gateway overhead

No public latency claim should be made until measured on the hosted implementation.

## Rate limiting and abuse controls

Rate limiting must happen before expensive provider work where possible while preserving retry safety.

Limits are tenant-scoped. A rate-limit response must not mutate protected state unless execution authority had already been acquired and the provider boundary may have been crossed.

The gateway must reject oversized requests and unsupported provider/action pairs before provider execution.

## Secret lifecycle

Phase 12C must define provider credential creation, rotation and revocation separately from `/v1/execute`.

Minimum requirements:

- encrypted at rest
- never returned after initial submission
- never included in GitHub, client SDK config examples or logs
- scoped to tenant/provider
- rotation does not mutate existing logical operation identity
- revocation fails closed for protected operations that require reconciliation

## Thin client contract

Framework, SDK and MCP clients should remain thin. They should:

1. create/reuse the stable logical operation ID,
2. construct the canonical effect binding,
3. call `/v1/execute`,
4. preserve the same identity across retries,
5. obey the returned decision,
6. never convert `BLOCK_UNKNOWN` into a fresh execution identity.

They should not reimplement the durable state machine.

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

Phase 12C is not complete until all of the following are demonstrated:

1. authenticated tenant-scoped `/v1/execute` transport exists in non-production/staging first,
2. durable multi-request operation state replaces the reference in-memory store,
3. concurrent identical deliveries produce at most one provider effect under the adapter assumptions,
4. same logical identity with a different effect hash returns `CONFLICT`,
5. confirmed operations replay without a second provider call,
6. an ambiguous provider outcome persists `UNKNOWN` and retries reconcile before re-execution,
7. provider truth unavailable returns `BLOCK_UNKNOWN`,
8. Stripe sandbox lost-ack proof passes through the hosted transport, not only the local runner,
9. tenant A cannot read/replay/affect tenant B operation state,
10. live-looking provider credentials are rejected in the sandbox/staging environment,
11. request retry storms do not multiply logical-operation metering,
12. logs contain no raw Once/provider secrets,
13. CI contains deterministic transport/auth/tenant-isolation/adversarial retry tests,
14. no production deployment or live-money enablement occurs without separate explicit approval.

## Phase sequence

Recommended implementation order:

1. freeze this transport/auth/tenant contract,
2. add durable tenant-scoped store and serialized authority,
3. add request validation + provider registry,
4. wire the proven Stripe refund adapter,
5. add metering and audit-safe observability,
6. run hostile retry/concurrency tests locally,
7. deploy to staging only after review,
8. repeat the real Stripe sandbox lost-ack proof through the hosted endpoint,
9. only then consider production deployment, billing entitlement and additional providers.

Phase 12C should be considered a hosted transport proof first and a commercial production service second. The safety semantics must survive the move from local reference code to networked multi-request operation.
# Once Gateway Contract — Phase 12A

Status: design + isolated reference core. Not deployed.

## Purpose

The gateway is the execution boundary for consequential agent actions. Frameworks and agents should not need to implement retry-safety themselves; they provide stable logical identity, effect-bearing data, and provider context, then obey the gateway decision.

## Proposed transport shape

A later hosted phase may expose a transport such as `POST /v1/execute`. Phase 12A freezes the semantic contract first.

Example request shape:

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
    "charge": "ch_...",
    "amount": 2500,
    "currency": "gbp"
  },
  "metadata": {
    "framework": "openai-agents"
  }
}
```

Example decisions:

```json
{ "decision": "EXECUTE", "state": "CONFIRMED" }
```

```json
{ "decision": "REPLAY_CONFIRMED", "state": "CONFIRMED" }
```

```json
{ "decision": "BLOCK_UNKNOWN", "state": "UNKNOWN" }
```

```json
{ "decision": "CONFLICT", "state": "CONFIRMED" }
```

`BYPASS` is reserved for operations that do not require the protected state machine.

## Logical identity

`operation_id` names the intended real-world operation, not an HTTP request, tool-call attempt, model turn, queue delivery, or process invocation.

Retries, redeliveries, reconnects, and fresh processes for the same intended effect must reuse the same logical identity.

## Effect binding

`effect_hash` binds the logical identity to all effect-bearing inputs needed to distinguish one external mutation from another.

If a request arrives with an existing logical identity but a different effect hash, the gateway returns `CONFLICT` and does not execute the provider action.

The hash is not a substitute for careful canonicalisation. Provider adapters or framework integrations must define which fields are effect-bearing.

## Durable states

Phase 12A needs only two persisted outcome states:

- `CONFIRMED`: authoritative evidence says the intended external effect exists or the execution returned success strongly enough to commit the result.
- `UNKNOWN`: the system cannot safely determine whether the effect happened.

`ABSENT` is reconciliation evidence rather than a blindly persisted permission state. It is only actionable when it is authoritative for the provider/action pair.

## Protected execution algorithm

1. Acquire serialized execution authority for the logical operation identity.
2. Read durable state.
3. Reject effect-hash drift with `CONFLICT`.
4. If state is `CONFIRMED`, return `REPLAY_CONFIRMED`.
5. If state is `UNKNOWN`, reconcile against authoritative provider truth.
6. If reconciliation returns `CONFIRMED`, persist confirmation and return `REPLAY_CONFIRMED`.
7. If reconciliation is `UNKNOWN`, return `BLOCK_UNKNOWN`.
8. If reconciliation returns authoritative `ABSENT`, a new provider attempt may proceed.
9. Before crossing the provider boundary, persist `UNKNOWN`.
10. On confirmed success, persist `CONFIRMED` and return `EXECUTE`.
11. On ambiguous transport/provider failure, leave `UNKNOWN` and return `BLOCK_UNKNOWN`.

## Authoritative absence

The burden of proof for `ABSENT` is deliberately high.

These are **not** sufficient by themselves:

- missing local state
- a cache miss
- a non-authoritative 404
- an eventually consistent read before its visibility window is known to have closed
- a timeout from a status endpoint
- inability to find an object using a different retry-generated identity

A provider adapter may return actionable `ABSENT` only when the lookup is authoritative for the same logical effect and its consistency semantics make absence safe to rely on.

## Provider adapter contract

A provider adapter is responsible for two operations:

```text
execute(context) -> confirmed result OR ambiguous error
reconcile(context) -> CONFIRMED | authoritative ABSENT | UNKNOWN
```

The adapter owns provider-specific facts such as:

- native idempotency keys
- request/operation identifiers
- authoritative lookup endpoints
- visibility lag
- terminal vs non-terminal provider states
- provider references needed for later reconciliation

The gateway core must not infer provider truth from generic HTTP status codes.

## Framework integration contract

Framework integrations should be thin. They should provide:

- stable logical operation identity
- effect-bearing inputs / effect hash
- target/action identity
- relevant provider context
- routing decision when a tool is confidently harmless enough to bypass

They should not independently reimplement the durable safety state machine.

## Safety property

Under the stated assumptions, the target property is:

```text
for a logical operation L, committed corresponding external effects E(L) <= 1
```

This is a safety property, not a liveness guarantee. The gateway may block when provider truth cannot be established.

## Assumptions

The property depends on:

- stable logical identity across retries
- complete effect binding
- durable serialized operation state
- execution crossing a controlled Once boundary
- trustworthy provider adapter logic
- authoritative reconciliation or willingness to block
- non-Byzantine storage/provider components

The gateway does **not** claim universal exactly-once execution across arbitrary systems.

## Phase progression

Phase 12A: contract + isolated safety core + adversarial tests.

Phase 12B: first real provider adapter and end-to-end reconciliation evidence; Stripe refunds are the preferred candidate.

Phase 12C: hosted transport, authentication, metering/observability, and thin framework/MCP clients after the semantics have been proven.

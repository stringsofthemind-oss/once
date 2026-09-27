# Phase 14A — Protected Write Contract

Status: DESIGN ONLY — EXISTING-RUNTIME AUDITED

This document freezes the proposed public semantics for a generic Once protected write. Phase 14A does not authorize runtime changes, deployment, release, package publication, billing changes, or external side effects.

## Goal

Make the safe implementation easier to consume than rebuilding retry-safety machinery application by application.

A caller supplies stable logical operation identity, the external conflict scope that must not receive competing unresolved writes, immutable input, the side-effecting execution callback, and optional reconciliation/verification callbacks. Once owns durable execution semantics across retry, crash/restart, session changes, concurrent attempts, and ambiguous outcomes.

## Existing-runtime audit

Phase 14A MUST extend the existing Once execution truth rather than create a second state machine.

The current repository already contains the core substrate:

- Runtime routing already requires a stable `operationId` for consequential HTTP writes and fails closed without it (`sdk/typescript/src/runtime/decision.ts`, `runtime/pipeline.ts`).
- Hosted execution already derives tenant-scoped logical-operation keys and canonical effect hashes (`workers/gateway/src/hosted-gateway-core.js`).
- `GatewayCore` already serializes same-operation execution, rejects same-operation/different-effect reuse, replays `CONFIRMED`, persists `UNKNOWN` before provider crossing, reconciles `UNKNOWN`, and refuses blind replay while ambiguity remains (`workers/gateway/src/gateway-core.js`).
- Hosted durable storage already persists `UNKNOWN` / `CONFIRMED` in the existing Durable Object SQL database and calls `storage.sync()` on safety-state writes before the provider boundary (`workers/runtime/src/hosted-gateway-durable.mjs`).
- Provider adapters already expose `preflight`, `execute`, and `reconcile` hooks.

Therefore Phase 14 is an **extension and productization of the existing execution model**, not a replacement runtime.

### Reuse mapping

| Phase 14 concept | Existing Once primitive | Decision |
| --- | --- | --- |
| stable logical identity | `operationId`, tenant operation key | REUSE |
| immutable input identity | canonical effect + `effectHash` | REUSE/GENERALIZE; do not add a competing fingerprint truth unless required |
| same-operation concurrency | `withLock(operationId)` / `KeyedSerialAuthority` | REUSE |
| durable ambiguity | `OutcomeState.UNKNOWN` + durable SQL/sync | REUSE |
| confirmed replay | `REPLAY_CONFIRMED` | REUSE |
| same ID / different effect | `CONFLICT` on `effectHash` mismatch | REUSE |
| reconciliation | adapter `reconcile()` + authoritative `ABSENT` / `CONFIRMED` | REUSE/GENERALIZE |
| conflict scope across different operation IDs | none in current core | NEW: Phase 14B |
| explicit post-execute verification/read-back | not a generic core stage | NEW: Phase 14C |
| attempt/evidence history | partial/runtime-specific | LATER EXTENSION |

The largest missing primitive is therefore **cross-operation conflict fencing**, not basic UNKNOWN/replay safety.

## Proposed TypeScript surface

```ts
const result = await once.protect({
  operationId: "smartstore:create:product-123:v7",
  conflictKey: "smartstore:account-42:product-123",
  input: registrationSnapshot,

  execute: async ({ signal }) => {
    return smartstore.create(registrationSnapshot, { signal });
  },

  reconcile: async ({ operation, input }) => {
    const remote = await smartstore.lookup(input.sellerProductCode);
    if (!remote) return once.absent();
    return once.found(remote);
  },

  verify: async ({ remote, input }) => {
    return compareListing(remote, input);
  },
});
```

Names are provisional until implementation review. Public API naming MUST NOT imply a second implementation beside `GatewayCore` / the existing runtime truth.

## Identity model

### `operationId`

Identifies one logical operation across retries, process restarts, transport sessions, agent turns, and tool-call/request IDs. A new transport or tool-call ID MUST NOT create a new logical operation.

### immutable effect fingerprint

The existing hosted runtime already canonicalizes the provider effect and computes `effectHash`. Phase 14 SHOULD reuse/generalize this concept rather than introduce an independent `inputFingerprint` state that could disagree with `effectHash`.

The same `operationId` with a different immutable effect MUST fail closed. This is already represented by `GatewayDecision.CONFLICT` in the current gateway core.

### `conflictKey`

Identifies the external side-effect scope for which unresolved competing writes are unsafe.

`operationId` answers: **which logical operation is this?**

`conflictKey` answers: **which external scope must not receive a competing write while a possibly-applied operation is unresolved?**

A fresh `operationId` or changed payload does not escape an unresolved `UNKNOWN` for the same conflict scope.

`conflictKey` is new semantics. It MUST be integrated into the same durable authority as logical-operation state, not maintained as an SDK-local or process-local guard.

## Logical operation vs attempt

The durable logical operation is authoritative. Execution attempts are history associated with that operation. Retry MUST NOT create a new logical operation merely because it creates a new attempt.

Attempt/evidence history is useful but is not required to create a parallel authoritative state machine. The existing logical record remains the execution truth.

## Public semantic outcomes

The existing runtime truth is currently `UNKNOWN` / `CONFIRMED` plus gateway decisions including `EXECUTE`, `REPLAY_CONFIRMED`, `BLOCK_UNKNOWN`, and `CONFLICT`.

Phase 14 adds semantics without rewriting that truth:

```ts
type ProtectedWriteOutcome<T> =
  | { state: "CONFIRMED"; result: T }
  | { state: "UNKNOWN"; operationId: string }
  | { state: "ABSENT_PROVEN" }
  | { state: "MISMATCH"; evidence?: unknown }
  | { state: "BLOCKED"; blockingOperationId: string };
```

`ABSENT_PROVEN` is primarily a reconciliation decision/evidence result. It need not become a new durable terminal operation state if the existing state machine can safely use authoritative `ABSENT` to determine eligibility for a subsequent provider attempt.

Likewise `BLOCKED` can remain a decision rather than a stored operation state.

## Core safety rule

> No evidence of success is not evidence of non-execution.

If execution may have crossed the external side-effect boundary and the result is ambiguous, the logical operation becomes `UNKNOWN`.

`UNKNOWN` MUST NOT be automatically re-executed.

The current `GatewayCore` already implements this core boundary by durably writing `UNKNOWN` before provider execution and reconciling it before any later provider attempt.

## Reconciliation

Reconciliation asks: **Did the possibly-applied external side effect happen?**

The current adapter contract already supports authoritative `CONFIRMED`, authoritative `ABSENT`, and fallback `UNKNOWN`. Phase 14 SHOULD generalize that provider-neutral contract rather than replace it.

Conceptually:

```text
UNKNOWN
  |
  +-- reconcile --> found + verified ------> CONFIRMED
  |
  +-- reconcile --> absence proven --------> provider attempt may become eligible
  |
  +-- reconcile --> found + mismatch ------> MISMATCH / blocked review path
  |
  +-- reconcile --> cannot determine ------> UNKNOWN
```

`ABSENT_PROVEN` does not authorize execution. Application authorization, entitlement, policy, approval, freshness, rate limits, and other guards may still deny a new provider attempt. This matches the existing hosted gateway ordering, where safe replay/reconciliation occurs before commercial/provider-attempt authorization and a new attempt is authorized separately.

## Verification

Verification is distinct from reconciliation.

Reconciliation asks whether an earlier effect happened. Verification asks whether the resulting external state satisfies the configured confirmation contract.

The existing generic gateway confirms after adapter `execute()` returns. Phase 14 high-assurance adapters need an optional verification/read-back stage before the operation is durably promoted to `CONFIRMED` when provider acknowledgement alone is insufficient proof.

This MUST be added to the existing gateway/provider adapter path rather than implemented as a second SDK state machine.

## Conflict fencing

An unresolved possibly-applied operation fences its configured `conflictKey`.

While the fence exists, a different tool-call ID, session/process, fresh operation ID, changed input, or application/UI retry control does not bypass it. A non-overlapping conflict scope SHOULD remain independently executable.

This is the principal new Phase 14B primitive.

The existing `KeyedSerialAuthority` is keyed by logical operation. It prevents same-operation interleaving but does not by itself prevent a second operation ID targeting the same external conflict scope. Phase 14B therefore needs a durable conflict-scope index/claim integrated with the hosted operation store.

A process-local `Map` lock is insufficient for crash/restart fencing. The durable conflict claim must survive the same boundaries as `UNKNOWN`.

## Phase 14A invariants

### I1 — Stable logical identity
Same `operationId` + same immutable effect resolves to one logical operation across retries/restarts.

### I2 — Effect conflict fails closed
Same `operationId` + different immutable effect MUST NOT execute.

### I3 — Concurrent duplicate suppression
Concurrent calls for one logical operation MUST NOT produce competing protected executions.

### I4 — Ambiguity becomes UNKNOWN
Possible external side effect + ambiguous result MUST become `UNKNOWN`.

### I5 — UNKNOWN is not retryable by default
`UNKNOWN` MUST NOT automatically execute again.

### I6 — UNKNOWN is durable
`UNKNOWN` survives process, session, agent-turn, and restart boundaries.

### I7 — Transport identity is not operation identity
Changing request/tool-call/session IDs MUST NOT create a new logical operation.

### I8 — UNKNOWN fences conflicting writes
An unresolved `UNKNOWN` blocks a competing protected write sharing its `conflictKey`, even if that write has a different `operationId`.

### I9 — Proven absence is required to clear duplicate-risk ambiguity
After `UNKNOWN`, a new provider attempt may become eligible only after deterministic evidence establishes that the prior effect was not applied / is remotely absent, or equivalent provider-specific proof accepted by the reconciliation contract.

### I10 — Confirmation obeys the configured proof contract
When verification is configured, transport/API success alone MUST NOT silently become `CONFIRMED` before that verification contract passes.

## Required negative controls for implementation phases

The eventual conformance suite must deliberately prove failure when each invariant is removed or weakened. At minimum it must cover:

1. acknowledgement lost after external effect;
2. process death after effect but before durable result persistence;
3. restart while operation is `UNKNOWN`;
4. retry using a different tool-call/request/session ID;
5. concurrent duplicate calls;
6. same operation ID with changed immutable effect;
7. fresh operation ID + changed input while prior operation on same conflict scope remains `UNKNOWN`;
8. reconciliation finds original effect;
9. reconciliation deterministically proves absence;
10. reconciliation remains ambiguous;
11. read-back finds mismatched external state;
12. unrelated conflict scope remains executable.

The target assertion for duplicate-sensitive scenarios is that the protected external effect count remains exactly one unless a prior attempt has been deterministically proven not applied and a later execution is independently authorized.

## Ownership boundary

Once owns execution-safety state and duplicate-risk decisions. Once does not become the application's general authorization, business-policy, pricing, permissions, or freshness authority.

In particular, `ABSENT_PROVEN` means **safe from the prior ambiguous-attempt duplicate risk**, not **authorized to execute**.

## Phase boundary

Phase 14A is contract/design work only.

Not authorized by this document:

- runtime behavior changes;
- schema/storage migrations;
- production provider calls;
- deployment;
- release;
- npm/MCP publication;
- billing changes;
- credential changes;
- automatic merge.

## Proposed follow-on sequence after audit

- Phase 14B — extend existing durable operation authority with `conflictKey` fencing; reuse `effectHash`, `UNKNOWN`, `CONFIRMED`, and current replay/reconciliation semantics
- Phase 14C — generalize reconciliation result helpers and add optional verification/read-back before confirmation
- Phase 14D — extend the existing safety/fault harness with cross-operation conflict and verification negative controls
- Phase 14E — connect `once doctor` / current protection planning to the protected-write scaffold
- Phase 14F — reference reconciliation/verification adapters and end-to-end examples

## Audit conclusion

The existing Once architecture is substantially closer to the protected-write contract than the initial Phase 14A draft assumed.

We do **not** need a second protected-write engine. Stable identity, effect conflict detection, same-operation serialization, durable `UNKNOWN`, pre-dispatch sync, reconciliation, confirmed replay, and provider adapters already exist.

The highest-value missing capabilities are:

1. durable `conflictKey` fencing across *different* operation IDs;
2. optional post-execute verification/read-back before `CONFIRMED`;
3. clearer provider-neutral reconciliation result helpers/evidence;
4. later attempt/evidence history and developer-facing scaffold/conformance UX.

Phase 14B should therefore be a narrow extension of `GatewayCore` + the existing durable hosted operation authority, with compatibility tests proving that existing `operationId` / `effectHash` behavior is unchanged.

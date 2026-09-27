# Phase 14A — Protected Write Contract

Status: DESIGN ONLY

This document freezes the proposed public semantics for a generic Once protected write. Phase 14A does not authorize runtime changes, deployment, release, package publication, billing changes, or external side effects.

## Goal

Make the safe implementation easier to consume than rebuilding retry-safety machinery application by application.

A caller supplies:

- stable logical operation identity;
- the external conflict scope that must not receive competing unresolved writes;
- the immutable input being acted upon;
- the side-effecting execution callback;
- an optional deterministic reconciliation callback;
- an optional verification callback.

Once owns durable execution semantics across retry, crash/restart, session changes, concurrent attempts, and ambiguous outcomes.

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

Names are provisional until implementation review, but the semantic separation is binding for Phase 14A.

## Identity model

### `operationId`

Identifies one logical operation across retries, process restarts, transport sessions, agent turns, and tool-call/request IDs.

A new transport or tool-call ID MUST NOT create a new logical operation.

### `inputFingerprint`

Once derives and durably associates an immutable fingerprint with the logical operation before execution may cross the side-effect boundary.

The same `operationId` with different immutable input MUST fail closed. An operation identity cannot silently be reused for different work.

### `conflictKey`

Identifies the external side-effect scope for which unresolved competing writes are unsafe.

`operationId` answers: **which logical operation is this?**

`conflictKey` answers: **which external scope must not receive a competing write while a possibly-applied operation is unresolved?**

A fresh `operationId` or changed payload does not escape an unresolved `UNKNOWN` for the same conflict scope.

## Logical operation vs attempt

The durable logical operation is authoritative. Execution attempts are append-only history associated with that operation.

At minimum an attempt record SHOULD be capable of retaining:

- attempt identity/number;
- input/request fingerprint;
- start/end timestamps;
- execution/error classification;
- whether the side-effect boundary may have been crossed;
- sanitized result/evidence digest where configured;
- reconciliation outcome where applicable.

Retry MUST NOT create a new logical operation merely because it creates a new attempt.

## Proposed public outcomes

```ts
type OnceOutcome<T> =
  | { state: "CONFIRMED"; result: T }
  | { state: "ABSENT_PROVEN" }
  | { state: "UNKNOWN"; operationId: string }
  | { state: "MISMATCH"; evidence?: unknown }
  | { state: "BLOCKED"; blockingOperationId: string };
```

The exact TypeScript shape may change during implementation review. The semantic outcomes may not be collapsed in a way that converts uncertainty into failure or success.

## Core safety rule

> No evidence of success is not evidence of non-execution.

If transmission/execution may have crossed the external side-effect boundary and the result is ambiguous, the logical operation becomes `UNKNOWN`.

`UNKNOWN` MUST NOT be automatically re-executed.

## Reconciliation

Reconciliation asks:

> Did the possibly-applied external side effect happen?

A reconciliation contract may resolve to:

- effect found and attributable to the original logical operation;
- remote absence deterministically proven;
- effect found but inconsistent with intended state;
- still unknown.

Conceptually:

```text
UNKNOWN
  |
  +-- reconcile --> found + verified ------> CONFIRMED
  |
  +-- reconcile --> absence proven --------> ABSENT_PROVEN
  |
  +-- reconcile --> found + mismatch ------> MISMATCH
  |
  +-- reconcile --> cannot determine ------> UNKNOWN
```

`ABSENT_PROVEN` does not itself authorize execution. It means the previous ambiguous attempt no longer prohibits execution on duplicate-effect grounds. Application authorization, freshness, policy, approval, rate limits, or other guards may still deny execution.

## Verification

Verification is distinct from reconciliation.

Reconciliation asks whether an earlier effect happened.

Verification asks whether the resulting external state satisfies the configured confirmation contract.

A provider response, including a nominal success response, does not have to mean `CONFIRMED` when a protected operation is configured to require read-back verification.

High-assurance flows may therefore use:

```text
execute
  -> provider accepted/result returned
  -> verify/read-back
       -> intended state proven -> CONFIRMED
       -> discrepancy          -> MISMATCH
       -> evidence ambiguous   -> UNKNOWN/REVIEW path
```

## Conflict fencing

An unresolved possibly-applied operation fences its configured `conflictKey`.

While the fence exists:

- a different tool-call ID does not bypass it;
- a different session/process does not bypass it;
- a fresh operation ID does not bypass it;
- changed input does not bypass it;
- application/UI retry controls do not bypass it.

A non-overlapping conflict scope SHOULD remain independently executable.

The fence may be released only by a transition that proves the old ambiguity no longer creates duplicate-side-effect risk, subject to higher-level application policy.

## Phase 14A invariants

### I1 — Stable logical identity
Same `operationId` + same immutable input resolves to one logical operation across retries/restarts.

### I2 — Input conflict fails closed
Same `operationId` + different immutable input MUST NOT execute.

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
An unresolved `UNKNOWN` blocks a competing protected write sharing its `conflictKey`.

### I9 — Proven absence is required to clear duplicate-risk ambiguity
After `UNKNOWN`, re-execution may become eligible only after deterministic evidence establishes that the prior effect was not applied / is remotely absent, or an equivalent provider-specific proof accepted by the reconciliation contract.

### I10 — Confirmation obeys the configured proof contract
When verification is configured, transport/API success alone MUST NOT silently become `CONFIRMED` before that verification contract passes.

## Required negative controls for implementation phases

The eventual conformance suite must deliberately prove failure when each invariant is removed or weakened. At minimum it must cover:

1. acknowledgement lost after external effect;
2. process death after effect but before durable result persistence;
3. restart while operation is `UNKNOWN`;
4. retry using a different tool-call/request/session ID;
5. concurrent duplicate calls;
6. same operation ID with changed input;
7. fresh operation ID + changed input while prior operation on same conflict scope remains `UNKNOWN`;
8. reconciliation finds original effect;
9. reconciliation deterministically proves absence;
10. reconciliation remains ambiguous;
11. read-back finds mismatched external state;
12. unrelated conflict scope remains executable.

The target assertion for duplicate-sensitive scenarios is that the protected external effect count remains exactly one unless a prior attempt has been deterministically proven not applied and a later execution is independently authorized.

## Ownership boundary

Once owns execution-safety state and duplicate-risk decisions.

Once does not become the application's general authorization, business-policy, pricing, permissions, or freshness authority.

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

## Proposed follow-on sequence

- Phase 14B — durable protected-write record + input fingerprint + conflict fencing
- Phase 14C — reconciliation SDK and provider-neutral result contract
- Phase 14D — fault/conformance harness
- Phase 14E — `once doctor` to protection scaffold workflow
- Phase 14F — reference reconciliation adapters and end-to-end examples

## Review questions before implementation

1. Should `conflictKey` be caller-supplied only, derived, or support both with explicit provenance?
2. What exact durable state names map cleanly onto the existing Once runtime without creating parallel truth?
3. Which transitions require compare-and-swap/fencing tokens rather than ordinary state updates?
4. How should `MISMATCH` interact with an already-known provider identity?
5. What minimum evidence is sufficient for provider-specific `ABSENT_PROVEN`?
6. Which evidence fields are safe to retain by default, and which require explicit sanitization hooks?
7. Can existing SDK/runtime primitives implement this contract without breaking compatibility?
8. What is the smallest public API that preserves these semantics without leaking internal machinery?

# Phase 14C — Reconciliation Contract

Status: DESIGN ONLY

Phase 14C defines the provider-neutral contract for resolving a protected Once operation after execution may have crossed an external side-effect boundary but the outcome is not safely known.

This phase builds on the existing Once durable `UNKNOWN` semantics and Phase 14B conflict-scope fencing. It must reuse the existing operation record and state authority rather than create a parallel reconciliation runtime.

## Goal

Make safe reconciliation a small, explicit adapter contract so application developers do not have to invent their own UNKNOWN recovery state machine.

The central rule remains:

> Lack of a successful response is not proof that an external effect did not happen.

When a protected operation is `UNKNOWN`, reconciliation gathers provider-specific evidence and maps it into a deliberately small set of provider-neutral outcomes.

## Proposed provider-neutral outcomes

```ts
type ReconcileOutcome<T = unknown> =
  | { status: "CONFIRMED"; result?: T; evidence?: ReconcileEvidence }
  | { status: "ABSENT_PROVEN"; evidence: ReconcileEvidence }
  | { status: "MISMATCH"; observed?: T; evidence: ReconcileEvidence }
  | { status: "UNKNOWN"; reason?: string; evidence?: ReconcileEvidence };
```

The exact TypeScript representation remains provisional until implementation review. The semantic distinctions are not interchangeable.

### `CONFIRMED`

Provider-specific evidence establishes that the original logical operation's external effect happened and satisfies the configured identity/verification requirements.

### `ABSENT_PROVEN`

Provider-specific evidence establishes strongly enough that the original ambiguous attempt did not apply the protected effect.

This is an execution-safety result, not authorization. It may make a later execution eligible from the perspective of duplicate-effect risk, but Once must not silently bypass application policy, approval, freshness, quota, or authorization checks.

### `MISMATCH`

An external object/effect exists in the relevant scope, but the evidence does not match the intended protected operation strongly enough to call it `CONFIRMED` or safely call it absent.

`MISMATCH` must fail closed by default.

### `UNKNOWN`

Available evidence cannot safely establish either confirmation or absence.

`UNKNOWN` remains fenced and must not trigger blind replay.

## Reconciliation input

The reconciliation callback should receive immutable identity/binding information from the durable operation rather than reconstructing truth from mutable application/UI state.

Conceptually:

```ts
reconcile: async ({
  operationId,
  conflictKey,
  effectHash,
  providerOperationKey,
  input,
  priorProviderReference,
  signal,
}) => {
  // provider-specific read/query/recovery logic
}
```

Not every adapter needs every field. The implementation should expose the minimum safe context without leaking storage internals.

## Evidence contract

Reconciliation decisions must be explainable enough for tests, audit, and safe recovery without requiring raw sensitive provider payloads to be persisted.

Proposed shape:

```ts
type ReconcileEvidence = {
  method: string;
  checkedAt: string;
  providerReference?: string;
  fingerprint?: string;
  summary?: Record<string, string | number | boolean | null>;
};
```

Evidence retention must be sanitized by default. Credentials, secrets, authorization headers, full payment details, arbitrary remote response bodies, and other sensitive material must not be retained merely because reconciliation observed them.

## Proof burden is asymmetric

`ABSENT_PROVEN` requires stronger semantics than "lookup returned nothing once".

Adapters must define what absence means for their provider and operation. Depending on the external system, sufficient proof may require one or more of:

- lookup by provider-native idempotency/operation key;
- lookup by immutable business identity;
- authoritative read-back from the system of record;
- bounded pagination/search proving no matching effect exists;
- provider receipt/status endpoint;
- a provider guarantee that a particular not-found response is authoritative for the operation scope.

Transient network failure, timeout, permission failure, incomplete pagination, stale replica reads, or an ambiguous search result must map to `UNKNOWN`, not `ABSENT_PROVEN`.

## Attribution requirement

Finding *an* external object in the conflict scope is not automatically proof that the original operation created it.

A reconciliation adapter must have an attribution rule strong enough for the operation class. Useful evidence may include:

- provider-native idempotency key;
- provider operation/request key;
- immutable application business key;
- exact protected effect fingerprint;
- provider receipt/reference captured before ambiguity;
- immutable field comparison where the provider exposes no stronger identity.

If attribution cannot be established, return `MISMATCH` or `UNKNOWN` rather than `CONFIRMED`.

## Verification relationship

Reconciliation and verification remain distinct concepts.

Reconciliation asks:

> Did the ambiguous original effect happen?

Verification asks:

> Does the resulting external state satisfy the protected operation's configured success contract?

An adapter may combine the provider reads needed to answer both questions, but Once must preserve the semantic distinction.

For example:

```text
UNKNOWN
  -> reconcile: matching provider object found
  -> verify: immutable protected fields match
  -> CONFIRMED
```

If the object exists but required fields differ:

```text
UNKNOWN
  -> reconcile: related object found
  -> verify: mismatch
  -> MISMATCH
```

## Transition rules

Phase 14C must preserve the existing Once state authority.

Conceptually:

```text
UNKNOWN
  +-- CONFIRMED ------> durable CONFIRMED; release duplicate-risk fence
  +-- ABSENT_PROVEN --> absence recorded; execution may become eligible only through the normal protected decision path
  +-- MISMATCH -------> fail closed / review path; fence remains unless an explicit safe resolution contract says otherwise
  +-- UNKNOWN --------> remain durable UNKNOWN; fence remains
```

A reconciliation callback must never directly execute the protected mutation.

A result of `ABSENT_PROVEN` must not be implemented as "call execute now" inside the reconciliation adapter. Control returns to the normal Once decision/admission path.

## Retry and failure semantics

Reconciliation itself is a read/recovery operation and may be retried where safe, but its failures must be classified conservatively.

At minimum:

- reconciliation timeout -> `UNKNOWN`;
- transport failure -> `UNKNOWN`;
- authentication/permission failure -> `UNKNOWN` plus diagnosable reason;
- incomplete provider pagination -> `UNKNOWN`;
- malformed/untrusted provider response -> `UNKNOWN` or `MISMATCH` as appropriate;
- explicit authoritative absence -> `ABSENT_PROVEN`;
- attributable matching effect -> `CONFIRMED` subject to verification requirements.

## Conflict fencing interaction

Phase 14B's `conflictKey` fence remains authoritative while reconciliation is unresolved.

A new operation against the same conflict scope cannot use reconciliation failure as an escape hatch.

Only a safe durable transition can change fence eligibility.

## Adapter capability declaration

Providers/actions should be able to declare reconciliation capability explicitly rather than implying all protected actions can prove absence.

Conceptually:

```ts
{
  protection: "PROTECT",
  reconciliation: {
    supported: true,
    canProveAbsence: true,
    canVerifyResult: true,
  }
}
```

For actions where deterministic reconciliation is impossible, Once should say so clearly. Such operations may remain `UNKNOWN` and require manual/provider-specific resolution rather than pretending safety can be automated.

## Phase 14C invariants

### R1 — Reconciliation never mutates the protected external effect
The reconciliation callback is read/recovery only with respect to the protected mutation.

### R2 — UNKNOWN remains fail-closed
Failure to reconcile does not authorize replay.

### R3 — Absence must be positively established
Not-found-like evidence is `ABSENT_PROVEN` only when the adapter contract defines it as authoritative and complete.

### R4 — Confirmation requires attribution
An external object cannot become `CONFIRMED` merely because something exists in the same scope.

### R5 — Verification requirements survive reconciliation
When the operation requires verification, finding the effect does not bypass verification.

### R6 — Reconciliation survives restart
Its decision is applied to the existing durable logical operation, not an in-memory replacement.

### R7 — Conflict fences survive failed reconciliation
`UNKNOWN`/`MISMATCH` cannot silently release a Phase 14B conflict fence.

### R8 — ABSENT_PROVEN is not authorization
It changes duplicate-risk knowledge only; normal execution policy remains authoritative.

### R9 — Evidence is bounded and sanitized
Reconciliation does not become a secret/raw-provider-payload persistence channel.

### R10 — Unsupported reconciliation is explicit
Once must not imply that every provider/action can automatically recover from ambiguity.

## Required negative controls for implementation

The implementation/conformance phase should prove at minimum:

1. timeout during reconciliation remains `UNKNOWN` and does not execute;
2. network error during reconciliation remains `UNKNOWN`;
3. permission failure does not become absence;
4. first-page not-found with incomplete pagination does not become absence;
5. unrelated object in same conflict scope does not become confirmation;
6. matching provider id but mismatched immutable protected fields becomes `MISMATCH` when verification requires those fields;
7. authoritative absence makes the operation eligible for the normal decision path but does not execute from inside reconciliation;
8. restart before reconciliation preserves `UNKNOWN` and the conflict fence;
9. restart after durable confirmation replays the confirmed result without provider execution;
10. reconciliation evidence sanitizer removes configured secrets/sensitive fields;
11. unsupported reconciliation remains safely `UNKNOWN` with actionable diagnostics;
12. two concurrent reconciliation attempts cannot create contradictory durable resolution.

## Compatibility requirements

Phase 14C must preserve existing adapters that currently return the existing reconciliation shapes used by the gateway/runtime. Implementation should either normalize legacy shapes at one boundary or introduce the new contract through a compatibility layer.

Do not require every existing adapter to migrate atomically.

No existing `UNKNOWN` record may be reinterpreted as `ABSENT_PROVEN` or `CONFIRMED` merely because the software version changed.

## Phase boundary

Phase 14C design work does not authorize:

- production provider calls;
- deployment;
- release;
- package publication;
- billing changes;
- credential changes;
- automatic merge.

## Review questions before implementation

1. Which existing reconciliation return shapes exist in gateway/runtime adapters today, and what is the smallest normalization layer?
2. Should `MISMATCH` be a durable operation state or a reconciliation outcome that leaves the operation fail-closed in `UNKNOWN` plus evidence?
3. How should authoritative absence be represented durably without creating a second state authority?
4. Which evidence fields should be persisted versus emitted transiently to callers/logs?
5. Should capability metadata be action-registration metadata, adapter metadata, or derived from callback presence?
6. What concurrency primitive should serialize multiple reconciliation attempts for one logical operation?
7. Which provider reference/effect identity fields are already durable and can be reused unchanged?
8. How should manual resolution interoperate with conflict fencing without weakening the safety contract?

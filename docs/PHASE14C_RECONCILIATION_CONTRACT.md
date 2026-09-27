# Phase 14C — Reconciliation Contract

Status: DESIGN ONLY — AUDITED AGAINST CURRENT GATEWAY/RUNTIME

Phase 14C defines the provider-neutral contract for resolving a protected Once operation after execution may have crossed an external side-effect boundary but the outcome is not safely known.

This phase builds on the existing Once durable `UNKNOWN` semantics and Phase 14B conflict-scope fencing. It reuses the existing operation record and state authority rather than creating a parallel reconciliation runtime.

## Goal

Make safe reconciliation a small, explicit adapter contract so application developers do not have to invent their own UNKNOWN recovery state machine.

The central rule remains:

> Lack of a successful response is not proof that an external effect did not happen.

When a protected operation is `UNKNOWN`, reconciliation gathers provider-specific evidence and maps it into a deliberately small set of provider-neutral outcomes.

## Audited implementation seam

The current `GatewayCore` already owns the correct reconciliation seam:

1. load the durable logical operation;
2. if it is `UNKNOWN`, call `adapter.reconcile(...)`;
3. normalize the adapter result at one boundary;
4. `CONFIRMED` becomes durable `CONFIRMED` and replays;
5. authoritative absence returns control to the ordinary protected preflight/admission/execution path;
6. all inconclusive/error cases remain durably `UNKNOWN` and fail closed.

Phase 14C therefore standardizes and hardens this existing seam. It does **not** introduce a second reconciliation engine or state machine.

## Provider-neutral outcomes

```ts
type ReconcileOutcome<T = unknown> =
  | { status: "CONFIRMED"; result?: T; evidence?: ReconcileEvidence }
  | { status: "ABSENT_PROVEN"; evidence?: ReconcileEvidence }
  | { status: "MISMATCH"; observed?: T; reason?: string; evidence?: ReconcileEvidence }
  | { status: "UNKNOWN"; reason?: string; evidence?: ReconcileEvidence };
```

### `CONFIRMED`

Provider-specific evidence establishes that the original logical operation's external effect happened and satisfies the configured identity/verification requirements.

### `ABSENT_PROVEN`

Provider-specific evidence establishes strongly enough that the original ambiguous attempt did not apply the protected effect.

This is an execution-safety result, not authorization. It changes knowledge about duplicate-effect risk and then returns control to the normal Once protected decision path. Application policy, approval, freshness, quota, entitlement and authorization checks remain authoritative before a new provider attempt.

### `MISMATCH`

An external object/effect exists in the relevant scope, but the evidence does not match the intended protected operation strongly enough to call it `CONFIRMED` or safely call it absent.

`MISMATCH` fails closed and leaves the durable operation `UNKNOWN`.

### `UNKNOWN`

Available evidence cannot safely establish either confirmation or absence.

`UNKNOWN` remains fenced and must not trigger blind replay.

## Durable state decision

Phase 14C does **not** add `ABSENT_PROVEN` or `MISMATCH` to the authoritative durable operation-state enum.

The authoritative durable states remain:

```text
UNKNOWN
CONFIRMED
```

This preserves the current runtime SQL/state authority and avoids creating competing recovery states.

- `CONFIRMED` reconciliation transitions the existing durable operation from `UNKNOWN` to `CONFIRMED`.
- `ABSENT_PROVEN` is a reconciliation outcome consumed within the locked decision path; it does not need to become a third durable operation state before the ordinary protected path proceeds.
- `MISMATCH` and `UNKNOWN` leave the operation durably `UNKNOWN` and keep conflict fencing closed.

No historical `UNKNOWN` record is reinterpreted merely because the software version changes.

## Single normalization boundary

Backward compatibility is handled in one place: `GatewayCore` reconciliation normalization.

The current legacy authoritative-absence shape remains accepted:

```ts
{ status: "ABSENT", authoritative: true }
```

The Phase 14C shape is:

```ts
{ status: "ABSENT_PROVEN", evidence?: ... }
```

Both normalize to the same internal semantic outcome: proven absence. The legacy shape is compatibility input, not the preferred new public contract.

Legacy `{ status: "CONFIRMED", ... }` and `{ status: "UNKNOWN", ... }` remain compatible.

Malformed, unsupported, non-authoritative legacy absence, and unrecognized statuses normalize conservatively to `UNKNOWN`.

## Reconciliation input

The existing gateway already supplies the core immutable identity/binding context:

```ts
reconcile({
  operationId,
  effectHash,
  conflictKey,
  payload,
  metadata,
  record,
})
```

Phase 14C should evolve this conservatively. Provider-operation identity and prior provider references already present in hosted metadata/durable records should be exposed through the existing context rather than copied into a parallel source of truth.

The adapter must not reconstruct logical identity from mutable UI/session/tool-call state.

## Evidence contract

Reconciliation decisions should be explainable enough for tests, audit, and safe recovery without requiring raw sensitive provider payloads to be persisted.

Proposed bounded shape:

```ts
type ReconcileEvidence = {
  method: string;
  checkedAt?: string;
  providerReference?: string;
  fingerprint?: string;
  summary?: Record<string, string | number | boolean | null>;
};
```

Evidence is diagnostic metadata, not a second state authority.

Initial Phase 14C implementation should prefer returning sanitized evidence to the decision/audit surface rather than expanding the durable SQL schema. Persistence can be added later only where a concrete recovery/audit requirement justifies it.

Credentials, secrets, authorization headers, full payment details, arbitrary remote response bodies, and other sensitive material must not be retained merely because reconciliation observed them.

## Proof burden is asymmetric

`ABSENT_PROVEN` requires stronger semantics than "lookup returned nothing once".

Adapters must define what absence means for their provider and operation. Depending on the external system, sufficient proof may require one or more of:

- lookup by provider-native idempotency/operation key;
- lookup by immutable business identity;
- authoritative read-back from the system of record;
- complete bounded pagination/search proving no matching effect exists;
- provider receipt/status endpoint;
- a provider guarantee that a particular not-found response is authoritative for the operation scope.

Transient network failure, timeout, permission failure, incomplete pagination, stale replica reads, or an ambiguous search result map to `UNKNOWN`, not `ABSENT_PROVEN`.

The current Stripe refund adapter is intentionally conservative: failure to find a matching refund in its bounded listing remains `UNKNOWN`; it does not claim authoritative absence.

## Attribution requirement

Finding *an* external object in the conflict scope is not automatically proof that the original operation created it.

A reconciliation adapter must have an attribution rule strong enough for the operation class. Useful evidence may include:

- provider-native idempotency key;
- provider operation/request key;
- immutable application business key;
- exact protected effect fingerprint;
- provider receipt/reference captured before ambiguity;
- immutable field comparison where the provider exposes no stronger identity.

The existing Stripe adapter demonstrates the intended direction by requiring its Once operation ID, effect hash, payment-intent identity and configured amount to match before returning `CONFIRMED`.

If attribution cannot be established, return `MISMATCH` or `UNKNOWN` rather than `CONFIRMED`.

## Verification relationship

Reconciliation and verification remain distinct concepts.

Reconciliation asks:

> Did the ambiguous original effect happen?

Verification asks:

> Does the resulting external state satisfy the protected operation's configured success contract?

An adapter may combine the provider reads needed to answer both questions, but Once preserves the semantic distinction.

```text
UNKNOWN
  -> reconcile: attributable provider object found
  -> verify: protected fields match
  -> CONFIRMED
```

If a related object exists but required immutable fields differ:

```text
UNKNOWN
  -> reconcile: related object found
  -> verify: mismatch
  -> MISMATCH
  -> durable state remains UNKNOWN
```

## Transition rules

```text
UNKNOWN
  +-- CONFIRMED ------> durable CONFIRMED; replay confirmed result
  +-- ABSENT_PROVEN --> stay inside same locked decision path; run normal protected preflight/admission before any new attempt
  +-- MISMATCH -------> durable UNKNOWN; fail closed; conflict fence remains
  +-- UNKNOWN --------> durable UNKNOWN; fail closed; conflict fence remains
```

A reconciliation callback never directly executes the protected mutation.

`ABSENT_PROVEN` must not be implemented as "call execute now" inside the reconciliation adapter. Control returns to the existing `GatewayCore` decision path.

## Retry and failure semantics

Reconciliation itself is a read/recovery operation and may be retried where safe, but failures are classified conservatively.

At minimum:

- reconciliation timeout -> `UNKNOWN`;
- transport failure -> `UNKNOWN`;
- authentication/permission failure -> `UNKNOWN` plus diagnosable reason;
- incomplete provider pagination -> `UNKNOWN`;
- malformed/untrusted provider response -> `UNKNOWN` or `MISMATCH` as appropriate;
- explicit authoritative absence -> `ABSENT_PROVEN`;
- attributable matching effect -> `CONFIRMED` subject to verification requirements.

## Conflict fencing and concurrency

Phase 14B's `conflictKey` lock/fence remains authoritative while reconciliation is unresolved.

The existing gateway executes reconciliation inside the same serialized decision path used for the protected operation/conflict scope. Phase 14C should preserve that authority rather than add a second reconciliation lock.

A new operation against the same conflict scope cannot use reconciliation failure as an escape hatch.

Only durable confirmation or proven absence followed through the ordinary protected path can change what happens next.

## Adapter capability declaration

Explicit reconciliation capability metadata remains desirable, but it is not required for the first normalization implementation.

For the first Phase 14C implementation, callback presence plus conservative normalization is sufficient to avoid broad registration-schema churn. A later additive capability surface may expose:

```ts
{
  reconciliation: {
    supported: true,
    canProveAbsence: true,
    canVerifyResult: true,
  }
}
```

No capability flag may weaken fail-closed behavior. If deterministic reconciliation is impossible, the operation remains `UNKNOWN` and requires provider-specific/manual resolution.

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

### R10 — Compatibility is normalized at one boundary
Legacy adapter shapes remain supported without making every adapter migrate atomically.

## Required negative controls for implementation

The implementation/conformance phase must prove at minimum:

1. timeout/throw during reconciliation remains `UNKNOWN` and does not execute;
2. transport/network error remains `UNKNOWN`;
3. permission failure does not become absence;
4. incomplete pagination/not-found observation does not become absence;
5. unrelated object in the same conflict scope does not become confirmation;
6. `MISMATCH` remains durably `UNKNOWN` and retains the conflict fence;
7. new `ABSENT_PROVEN` reaches the normal preflight/admission path but cannot bypass a failing admission policy;
8. legacy `{status:"ABSENT", authoritative:true}` still reaches the same normal protected path;
9. legacy `{status:"ABSENT", authoritative:false}` remains `UNKNOWN`;
10. restart before reconciliation preserves `UNKNOWN` and the conflict fence;
11. restart after durable confirmation replays without provider execution;
12. concurrent reconciliation attempts remain serialized by the existing operation/conflict authority;
13. malformed/unrecognized reconciliation statuses fail closed;
14. reconciliation evidence exposed by the gateway is bounded/sanitized before it reaches durable/audit surfaces.

## Compatibility requirements

Phase 14C preserves existing adapters and durable records.

- Existing `CONFIRMED` return shapes continue to work.
- Existing authoritative legacy `ABSENT` return shapes continue to work.
- Existing `UNKNOWN` return shapes continue to work.
- Existing durable state remains `UNKNOWN | CONFIRMED`.
- No adapter migration is required atomically.
- No existing `UNKNOWN` record becomes `ABSENT_PROVEN` or `CONFIRMED` merely because the software version changes.

## Audited implementation plan

The smallest safe implementation is:

1. extend `normalizeReconciliation()` in `GatewayCore` to recognize `ABSENT_PROVEN` and `MISMATCH` while retaining legacy normalization;
2. keep `MISMATCH` on the fail-closed `BLOCK_UNKNOWN` path;
3. keep `ABSENT_PROVEN` on the existing path that proceeds to preflight/admission before a provider attempt;
4. add bounded/sanitized diagnostic reconciliation metadata only where it can be done without changing durable state authority;
5. add adversarial/conformance tests before changing any production adapter behavior;
6. leave the Stripe refund adapter conservative unless a separate proof establishes a genuinely authoritative absence mechanism.

No SQL state migration is required for this first implementation.

## Phase boundary

Phase 14C design work does not authorize:

- production provider calls;
- deployment;
- release;
- package publication;
- billing changes;
- credential changes;
- automatic merge.

## Decisions frozen by audit

1. Reuse the existing `GatewayCore` reconciliation seam.
2. Use one normalization boundary for old and new adapter return shapes.
3. Keep durable operation states as `UNKNOWN | CONFIRMED`.
4. `MISMATCH` is a reconciliation outcome, not a new durable state.
5. `ABSENT_PROVEN` is a reconciliation outcome, not a new durable state or authorization grant.
6. Preserve existing conflict-scope serialization rather than add a second lock authority.
7. Do not weaken the current Stripe adapter's conservative absence semantics.
8. Avoid registration/capability-schema expansion in the first implementation unless tests expose a concrete need.

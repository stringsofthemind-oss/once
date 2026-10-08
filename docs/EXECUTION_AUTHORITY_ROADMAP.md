# Once execution-authority roadmap

Status: design/qualification plan. This document does **not** claim that the listed enterprise capabilities ship today.

## Goal

Make Once the execution-authority boundary for consequential agent actions.

The surrounding platform answers **may this actor perform this kind of action?**

Once answers **may this exact logical consequence execute now, or must it replay, conflict, reconcile, require reapproval, or fail closed?**

The model is not the final authority for identity, credentials, provider account, durable history, reconciliation, or approval scope.

## Four bindings

Every high-consequence protected action should be evaluable across four independent bindings:

1. **Identity** — tenant/security domain, subject/workload, provider account.
2. **Authority** — policy/mandate, approval scope, credential/session authority.
3. **Intent** — stable logical business operation, distinct from transport attempt and payload.
4. **Effect** — complete consequence-bearing inputs and provider boundary.

The draft machine contract is in
[once-execution-authority-contract-v1-draft.json](./once-execution-authority-contract-v1-draft.json).

The candidate conformance vectors are in
[../conformance/once-execution-authority-v1-vectors.json](../conformance/once-execution-authority-v1-vectors.json).

## Runtime decision vocabulary

The candidate host-facing decision vocabulary is deliberately small:

- `EXECUTE`
- `REPLAY_CONFIRMED`
- `CONFLICT`
- `RECONCILE_REQUIRED`
- `REQUIRE_REAPPROVAL`
- `DENY_AUTHORITY`
- `DENY_BINDING`
- `DENY_STATE`

`UNKNOWN` remains an execution state, not retry permission.

Only `EXECUTE` may authorize a fresh external dispatch. Every other decision is non-dispatching.

## Enterprise acceptance lanes

### 1. Mandatory execution boundary

A correctly configured agent host must make the Once boundary unavoidable for admitted consequential tools.

Required properties:

- consequential tools cannot silently route around Once;
- catalog/tool drift invalidates prior admission;
- bypass is explicit and reviewable;
- the model cannot create a new operation identity merely to escape an existing `UNKNOWN`, `CONFLICT`, or confirmed record;
- unsupported or ambiguous routing fails closed.

Existing Connect/MCP work is the starting point. Do not create a second execution engine.

### 2. Multi-host execution authority

The released local SQLite path remains valuable for developer/same-machine use, but is not the final enterprise coordination model.

Enterprise authority needs:

- transactional shared state;
- one-winner reservation semantics;
- fencing of stale workers;
- multi-process/multi-host concurrency proof;
- explicit state schema/version admission;
- no automatic recreation of expected missing authority;
- HA and disaster-recovery procedures;
- backup/restore semantics that preserve execution history.

A database path, generation UUID, signature or self-contained hash chain is not sufficient proof that a restored history is the latest history.

A separate continuity/anti-rollback authority is required before Once can claim detection of older-but-valid history.

### 3. Identity and delegated authority

The protected boundary must consume trusted host/provider facts rather than infer them from model prose.

Target bindings:

- tenant/security domain;
- human or service principal;
- agent/workload identity;
- delegated role/group/mandate;
- provider account;
- credential/session binding reference;
- policy version;
- approval/mandate reference and scope.

Do not persist raw bearer tokens, passwords, API secrets, private keys, session tokens or authorization headers as identity/effect material.

Credential rotation must be able to invalidate the old authority binding without silently minting a new logical operation.

### 4. Approval binding

Approval of one consequence must not authorize a changed consequence.

Examples that must fail closed or require reapproval:

- amount changes;
- currency changes;
- payee/merchant changes;
- provider account changes;
- hotel/flight/market/resource changes;
- quantity/stake changes;
- deadline/slippage changes when they are economically material;
- changed cancellation/refund semantics.

Once should consume approval evidence; it should not become the enterprise IAM or human-approval product.

### 5. Provider capability contract

Every certified provider adapter should publish a machine-readable capability profile covering:

- provider identity;
- adapter version;
- provider account binding;
- native idempotency support and key semantics;
- authoritative lookup support;
- reconciliation identity;
- definitive/non-definitive absence;
- eventual-consistency behaviour;
- partial-execution possibility;
- credential mode;
- result/receipt identity;
- sandbox/test mode;
- unsupported operations.

Candidate grades:

- **A** — native duplicate suppression + authoritative reconciliation;
- **B** — authoritative reconciliation, Once boundary provides duplicate suppression;
- **C** — native duplicate suppression, incomplete authoritative readback;
- **D** — provider cannot establish enough post-dispatch truth; ambiguity may remain `UNKNOWN`.

A provider grade describes evidence quality, not a universal exactly-once guarantee.

### 6. Payments

First payment qualification should prove the complete path, not merely call a sandbox API.

Minimum adversarial evidence:

- first authorized dispatch;
- identical retry;
- changed amount;
- changed currency;
- changed payee/customer/account;
- concurrent same-operation calls;
- crash before dispatch;
- crash after provider commit before local acknowledgement;
- process restart;
- delayed/eventually-consistent lookup;
- provider lookup unavailable;
- provider-native idempotency retained and composed with Once;
- credential rotation/account mismatch;
- stale authority/state rejection;
- no cardholder secrets in Once state/telemetry.

Provider-native idempotency remains enabled when available.

### 7. Bookings and reservations

Booking qualification must cover scarce inventory and changing economics.

Bind at least:

- provider/account;
- itinerary/resource identity;
- dates/times;
- party/quantity;
- price/currency;
- quote/fare/rate identity where available;
- freshness/expiry;
- cancellation/refund conditions when economically material.

Required lost-ack case:

provider accepts reservation -> response is lost -> retry pressure arrives -> Once blocks -> authoritative booking lookup recovers the unique reservation -> original result is retained/replayed -> no second reservation.

### 8. Partial execution / sagas

A multi-action plan must never treat a confirmed child effect as undone merely because the parent workflow restarts.

Future plan identity should support child operation identities such as:

```
TRIP-123
  HOTEL-1      CONFIRMED
  FLIGHT-1     CONFIRMED
  DEPOSIT-1    UNKNOWN
  TRANSFER-1   NOT_STARTED
```

After partial execution, stale remaining actions are not automatically valid. Reconcile actual external state and create a newly authorized plan where required.

### 9. Evidence and observability

Enterprise evidence should be machine-consumable without exposing secrets.

Target receipt fields:

- logical operation identity;
- effect digest/equivalent canonical binding;
- tenant/subject/workload references;
- provider and provider-account reference;
- decision and execution state;
- provider receipt/result reference;
- reconciliation method and evidence reference;
- approval/policy reference;
- timestamps;
- adapter/runtime versions.

Signed receipts may provide tamper evidence. A local signature does not make provider evidence provider-signed and does not solve valid-history rollback by itself.

Target telemetry:

- `once.execute`
- `once.replay`
- `once.conflict`
- `once.unknown`
- `once.reconcile`
- `once.authority_mismatch`
- `once.binding_failure`
- `once.state_unavailable`
- `once.reapproval_required`

Use OpenTelemetry-compatible trace/log/metric semantics where practical.

### 10. Supply-chain and procurement readiness

Before a serious enterprise/financial production claim, build the evidence pack around the software as well as the runtime:

- SBOM per official release;
- signed build provenance;
- immutable source commit/artifact hash mapping;
- trusted publishing where supported;
- vulnerability disclosure/security advisory process;
- dependency/update policy;
- threat model;
- incident-response plan;
- BCP/DR and RTO/RPO;
- DPA/privacy/data-flow documentation for hosted offerings;
- retention/deletion controls;
- subprocessor inventory;
- independent penetration testing;
- SOC 2 / ISO 27001 readiness for a managed enterprise service.

These are acceptance requirements around Once, not reasons to weaken the execution semantics.

## Order of implementation

### Foundation

1. Freeze and test the machine-readable identity + authority + intent + effect contract.
2. Freeze decision codes and conformance vectors.
3. Add provider capability profiles and adapter qualification rules.
4. Add runtime evidence/reason-code mapping without changing the authoritative execution kernel.

### Enterprise execution

5. Build shared transactional authority and fencing.
6. Build external continuity/anti-rollback proof.
7. Add enterprise identity/authority bindings.
8. Add mandatory middleware/gateway admission so the model cannot bypass the boundary.
9. Add OpenTelemetry/audit export.

### Vertical proof

10. Qualify one payment provider end to end.
11. Qualify one booking/reservation provider end to end.
12. Add multi-action/partial-execution conformance.
13. Run independent external adversarial reviews.

## Non-goals

Do not turn Once into a general IAM, secrets vault, payment processor, booking engine, workflow engine, DLP suite or universal agent firewall.

Do not weaken fail-closed behaviour to improve apparent completion rate.

Do not call a local or synthetic proof provider certification.

Do not claim arbitrary sibling connectors are protected unless the host actually routes their effects through an admitted Once boundary.

Do not claim universal exactly-once execution.

## Success condition

Once becomes a no-brainer when an agent platform can inspect the contract, prove the host routes every admitted consequence through it, and receive a deterministic execution decision backed by durable authority and provider evidence — without asking the model to reason about retry safety itself.

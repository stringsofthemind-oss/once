# Phase 15G — route-matched SDK proof

Phase 15G closes the Phase 15 completion gate for the exact SDK route applied by Phase 15C.

The supported source transform calls `Once.execute()`, which uses `/v1/execute` with the existing `{ operation_id, provider, action }` contract. Verification therefore exercises that same SDK route rather than borrowing proof from `protectLocal` or the newer hosted Gateway contract.

`once doctor <project> --verify` is explicit and networked. It requires `ONCE_API_KEY`, uses only the synthetic `blind_test` provider, deliberately discards the first successful `/v1/execute` acknowledgement, lets the SDK retry the same stable operation ID, then checks Once truth.

A protection receipt is promoted to `PROTECTED` only when truth shows:

- `ledger_state = CONFIRMED`
- at least two attempts
- exactly one synthetic external effect

The user's configured application provider is never invoked by this proof. A failed proof leaves the receipt pending. A source change after verification makes the receipt stale and removes the current protection claim.

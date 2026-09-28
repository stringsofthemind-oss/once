# Once reconciliation adapter contract

Reconciliation changes knowledge, not the protected external effect.

A reconciliation adapter MUST use a read-only provider truth surface. It MUST NOT call the protected write as a way to discover whether that write happened.

## Evidence states

- `CONFIRMED` — authoritative provider evidence identifies the same logical operation and the same complete effect-bearing payload. A replayable result is available.
- `ABSENT_PROVEN` — the provider contract authoritatively proves that the exact logical operation does not exist. Mere search miss, timeout, stale index or generic 404 is not enough.
- `MISMATCH` — provider evidence exists for the operation lookup, but the stable logical identity or complete effect payload does not match the requested operation.
- `UNKNOWN` — provider truth is unavailable, incomplete, ambiguous or not authoritative enough to make one of the statements above.

## Execution boundary

Adapters do not authorize execution.

`ProviderReconciliationAdapter.reconcile()` converts the richer evidence model to the existing local Once observation contract only for compatibility with `protectLocal` and Connect:

- `CONFIRMED` -> `CONFIRMED`
- `ABSENT_PROVEN` -> `ABSENT`
- `MISMATCH` -> `UNKNOWN`
- `UNKNOWN` -> `UNKNOWN`

Local protection remains fail-closed after an ambiguous attempt. In particular, even an `ABSENT` reconciliation observation does not cause local mode to redispatch the protected write.

## Authoritative HTTP status adapter

`createHttpStatusReconciliationAdapter()` performs only a GET status lookup and does not follow redirects.

By default, **no HTTP status proves absence**. A caller may explicitly configure HTTP `404` and/or `410` as `authoritativeAbsenceStatuses` only when the provider's documented status endpoint guarantees that those responses are authoritative for the exact operation ID.

Successful responses are decoded into an operation ID, effect payload and replayable result. Once then binds the returned operation ID and deterministic effect fingerprint against the original protected call before returning `CONFIRMED`.

Timeouts, network failures, non-authoritative HTTP errors, invalid JSON and unusable decoder results remain `UNKNOWN`.

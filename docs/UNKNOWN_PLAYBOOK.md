# UNKNOWN: the action may already have happened

UNKNOWN means Once cannot safely establish the external outcome. A timeout,
crash, lost response or unusable receipt does not prove failure. Your application
must stop blind mutation retries and preserve the original intent and state.

## Safe application response

Tell the user the outcome is being checked. Keep the business action unresolved.
Record a correlation ID and machine-readable error code without logging secrets.
For local wrappers, use `LocalProtectionError.code`; errors are not permission
to invoke the provider directly.

| Outcome | Next safe step |
|---|---|
| Receipt | Record the original result; replay is not a live object refresh |
| `IN_FLIGHT` | Wait with a bounded retry budget and reuse the same intent/file |
| `UNKNOWN` | Read provider truth under the original intent, or escalate |
| `CONFLICT` | Investigate changed effect fields; do not generate a replacement ID automatically |
| `UNREPLAYABLE_RESULT` | The effect may exist; recover a JSON-safe receipt |
| `EXECUTION_RIGHT_LOST` | Treat completion as uncertain; reconcile |
| `STATE_UNAVAILABLE` | Restore access to existing authority; do not create an empty substitute |

## Recover the original receipt

Supply a read-only `reconcile({ id, payload })` callback to `protectLocal` or
Connect. It must validate that provider evidence matches the exact intended
action and complete effect. Return `{ state: "CONFIRMED", result: receipt }`
only with authoritative evidence and a replayable receipt. A retry through the
same wrapper can then recover and persist it; later retries replay it.

A timeout, rate limit, edited object, ambiguous match or search miss remains
UNKNOWN. Local mode **does not redispatch after ambiguity even if reconciliation
returns ABSENT**: an old request might still commit. A hosted/provider integration
can have different capability requirements; inspect its contract before relying
on re-execution.

For the hosted client, `once.truth(operationId)` inspects the supported service
status; that is not a generic local-file inspection API. The local path uses the
original protected call and reconciliation callback. Do not imply these APIs
are interchangeable.

The [GitHub recovery example](../sdk/typescript/examples/GITHUB_ISSUE_RECOVERY.md)
demonstrates correlation without retaining a lost issue number, under explicit
trusted-repository assumptions. It is not a universal GitHub exactly-once adapter.

## If truth stays unavailable

Escalate to a named operator with the original intent, expected effect, provider
account and last safe evidence. Keep the operation blocked. A retry budget
expiring does not make another write safe. Do not clear the database, expire the
identity, change the account or expose an unwrapped fallback.

A genuinely new business action needs separate authorization and intent. If the
original is unresolved, explicitly account for the possibility that it occurred;
a new ID is not a recovery mechanism. Compensation is a separate consequential
operation and needs its own identity and provider semantics.

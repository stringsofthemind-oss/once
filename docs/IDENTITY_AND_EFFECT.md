# Own the identity; bind the effect

Before integration, answer: **what durable application record represents one
intended action?** Once cannot decide this from the text of a model response.

Persist a new intent before the first provider request. A random UUID generated
once and stored is valid. Generating it inside each retry is not. A deterministic
ID is only correct if its business semantics are correct.

| Situation | Identity | Effect |
|---|---|---|
| Retry after timeout/restart | Original intent | Original bound inputs |
| Two separate identical orders | Different persisted intents | May be identical |
| Correcting amount under existing intent | Original intent | Changed amount produces CONFLICT |
| Second legitimate partial refund | Separate refund-request intent | Separately authorized amount |

An order ID alone cannot distinguish multiple legitimate refunds for that order.
Scope identities by environment, tenant/provider account and operation type.
Do not change that scope to escape an unresolved action. Framework call IDs,
timestamps and freshly generated request IDs identify attempts, not intentions.

## Effect review

Review the actual outbound mutation and include every value that changes it:

- Provider account/tenant and destination resource.
- Amount and currency, quantity, product or reservation details.
- Message recipient, content, attachments and relevant delivery options.
- Operation type, behavior-changing API version/defaults and configuration.

Exclude attempt-only tracing fields and fault-injection flags only after checking
they cannot change the real effect. Do not solve omissions by silently hashing
all inputs. Conversely, conservative full-input binding can conflict when
volatile metadata changes; explicit reviewed selectors avoid that problem.

Ordinary arguments are snapshotted. Opaque handles, credentials, closures and
dynamic receivers remain trusted application code; the wrapper does not prove
that the function uses only declared fields. Prefer constructing the provider
request directly from bound data. A declared account must match the account
selected by the provider credential.

Keep identity encoding and effect semantics stable across retries, deployment,
upgrade and rollback. Versioning a tool name or operation namespace can make an
old retry look like a new action. Review migration before changing it.

For agents, persist and inject intent in trusted application code. A tool input
called `intentId` is not automatically trustworthy if the model invents it each
time. Do not expose an unwrapped equivalent tool alongside the protected one.

See [UNKNOWN](UNKNOWN_PLAYBOOK.md) for blocked actions and
[production operation](PRODUCTION_OPERATION.md) for state continuity.

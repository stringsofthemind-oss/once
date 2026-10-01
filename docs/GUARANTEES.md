# Execution-safety boundaries

Current public TypeScript SDK: **0.1.22**. This matrix describes the inspected
implementation, not certification of every deployment or provider. Once does
not claim universal exactly-once execution or atomicity with arbitrary external
systems. Approval, correctness of the business action and access control are
separate responsibilities.

| Behavior | Supported? | Guarantee on the local path | Requires / boundary |
|---|---|---|---|
| Confirmed replay | Yes | Returns the stored replayable receipt without another wrapper dispatch | Same ID, effect and retained SQLite file |
| Changed effect | Yes | CONFLICT prevents a second wrapper dispatch | Complete explicit effect binding |
| Same payload, new intent | Yes | Separate intended action may execute | Application-owned distinct identity |
| Uncertain outcome | Yes | UNKNOWN blocks blind redispatch | Every call stays behind wrapper |
| Provider recovery | Conditional | Valid CONFIRMED evidence can persist original receipt | Authoritative read-only lookup and safe receipt |
| Absence after ambiguity | No local redispatch | Even ABSENT evidence does not authorize another local write | Provider-native guarantee needed for other recovery models |
| Restart replay | Yes, bounded | Retained confirmed state replays; abandoned claim blocks/reconciles | Same persistent authority; early retry can be IN_FLIGHT |
| Same-process concurrency | Yes, bounded | One cooperating claimant dispatches | Shared file and supported filesystem |
| Multiple processes | Yes, bounded | SQLite coordinates cooperating callers sharing one file | One machine, SQLite WAL/locking support |
| Multiple hosts | Not via local SQLite | Separate files do not coordinate | Review a supported shared hosted/backend contract |
| Unreplayable receipt | Blocks | No blind retry after an effect may have occurred | Reconcile to JSON-safe result |
| Provider-internal retries | Not generically | Wrapper controls its dispatch, not every provider SDK attempt | Adapter review/native idempotency |
| Ledger loss/old backup | Not covered; measured redispatch | Complete loss and stale restore each produced two controlled effects | Stop writes; [continuity evidence](AUTHORITY_CONTINUITY.md) |
| Wrong identity / omitted effect | Not automatically repairable | Declared semantics are trusted | Application review against actual request |

## Deployment distinctions

- **TypeScript local:** Node.js 24.15+, persistent same-machine SQLite. No API key
  or provider registration needed to wrap an existing function.
- **Python reference core:** a separate capability-aware reference backend.
  Its provider-idempotency/fencing recovery contract is not identical to
  TypeScript `protectLocal`; see `sdk/python/src/once_agent/core.py`.
- **Existing hosted client/runtime:** requires authentication and supported
  provider setup. A public endpoint does not prove the new gateway gates are on.
- **New hosted gateway:** repository contracts record isolated Stripe-sandbox
  staging evidence. The production-readiness document explicitly says the new
  path is not deployed or wired to production. Verify active version and flags
  before claiming otherwise.
- **MCP discovery/setup:** helps integrate protection. It does not intercept
  every external action simply because it is installed. A reviewed runtime
  proxy/connected tool boundary is a separate path.

Runtime tests using the local SQLite harness do not model Cloudflare output
gates or scheduling. Framework fixtures and real-provider experiments support
their tested failure models; neither establishes universal behavior.

See [hosted contract](GATEWAY_HOSTED_TRANSPORT_V1.md),
[readiness](GATEWAY_HOSTED_PRODUCTION_READINESS_V1.md),
[local details](../examples/local-function/README.md) and
[production operation](PRODUCTION_OPERATION.md).

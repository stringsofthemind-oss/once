# Explicit connected-tool protection

`protectToolCall` is a local, credential-independent boundary around a callable supplied by the host. It reuses `protectLocal` and its SQLite state machine; it does not introduce a second execution ledger. Existing APIs and schemas are unchanged.

```ts
import { protectToolCall } from "@once-agent/sdk";

const receipt = await protectToolCall({
  operationId: "account-A:comment:217:request-001",
  statePath: "/persistent/once/operations.sqlite",
  effect: {
    tool: "github.account-A.add_comment",
    args: { repo: "owner/disposable-lab", issue: 217, body: "Exact text" },
  },
  metadata: { traceId: "trace-for-this-attempt" },
  execute: async ({ args }) => hostTools.addComment(args),
  reconcile: async ({ effect }) => hostTools.findMatchingComment(effect.args),
});
```

The host owns its connector authority. Neither Once nor this primitive requests a GitHub token or calls the provider directly. See `examples/connected-tool/comment.mjs` for a runnable simulated host, and an injectable host contract for real connected tools.

## Contract and guarantees

- Caller supplies a stable, nonempty `operationId`. No semantic identity is guessed. Missing identity throws `IDENTITY_REQUIRED` before dispatch. Use separate IDs for separate intentional effects; never generate a new ID merely to retry.
- Fingerprint includes contract version, complete tool identity, and all effect-bearing `args`. Object key order is canonicalized with the existing SHA-256 binding. Arrays preserve order. Include account/tenant, target, exact body, and any other input that can change the effect. Same ID with a changed fingerprint throws `CONFLICT` before dispatch, even while UNKNOWN.
- `metadata` is not fingerprinted or passed to callbacks. Trace IDs, retry counters, and timeouts may be captured by the caller only when they cannot change the effect.
- The effect is strictly snapshotted and deeply frozen before asynchronous work. Dispatch and reconciliation receive this same snapshot. Unsupported values, proxies, accessors, hidden properties, cycles, functions, and serialization hooks fail before dispatch. Arguments must be a plain object of supported JSON data.
- Confirmed JSON-safe receipts replay durably, including after process restart. Concurrent claims use existing SQLite coordination. Active claims return `IN_FLIGHT`. Expired claims become UNKNOWN and never redispatch.
- Any exception after entering `execute`, including one that the caller believes happened before dispatch, produces `UNKNOWN`. The primitive has no independent proof that a thrown connector error means no side effect occurred. A successful tool return must mean confirmed provider completion; a queued acceptance or MCP error envelope is not proof of completion. The host must normalize these to an appropriate receipt or throw to keep the outcome ambiguous.
- `reconcile` returns `{ status: "CONFIRMED", result }`, `{ status: "NOT_FOUND" }`, or `{ status: "UNKNOWN" }`. A CONFIRMED result must be supported JSON data. Confirmation must identify this exact effect authoritatively, not merely similar text or the latest comment. Multiple matches, incomplete pagination, eventual consistency, permission errors, and lookup timeouts must remain UNKNOWN.
- NOT_FOUND never authorizes redispatch. An absent result may reflect delayed visibility or an in-flight write. Missing, failed, malformed, or inconclusive reconciliation also stays blocked. A reconciliation path is optional for an initial call, but recovery cannot succeed without authoritative positive truth. There is no generic safe reset or force-retry API.
- Non-replayable results fail closed with `UNREPLAYABLE_RESULT`; reconcile to a JSON-safe receipt before continuing.

## Limits and host responsibilities

Requires Node.js 24.15+ and one persistent local SQLite authority shared by all retries. This is duplicate-dispatch prevention under those assumptions, not universal exactly-once execution. Deleting, replacing, rolling back, or switching the ledger across restarts loses the authority. Separate hosts or independent files are not coordinated.

The SDK cannot verify semantic completeness of args, captured closure state, selected connector credentials, or the tool's internal retries. Call `execute` using its supplied effect snapshot, include authority identity, and ensure transport retries cannot themselves duplicate an effect. Callback retries that bypass Once bypass protection. A zero-argument callback is type-compatible but must bind exactly the declared effect; snapshotting cannot constrain arbitrary closure behavior. Read-only reconciliation is a host responsibility.

No arbitrary caller-provided fingerprint hook, inferred identity, automatic tool classification, `wrapTool`, universal MCP proxy, or automatic model interception is included. An explicit primitive is sufficient for a future reviewed MCP/connector boundary: that boundary must supply stable identity, complete effects, authority binding, normalized completion receipts, and safe provider lookup. MCP transport request IDs and annotations alone are insufficient.

## Validation scope

Regression tests use host-supplied functions and a durable disposable effect log, including a separate Node process for receipt replay. They do not prove live GitHub connector behavior. The cold-user test and its evidence are untouched. No private guidance, provider write, publication, release, deployment, or merge is part of this change.

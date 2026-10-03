# Operation Natural Placement

Design decision recorded before implementation, 2026-10-03. Base: ba77545ae5e2aecf00adbd3dba1280f4903579b0 (fetched upstream main).

## Problem and evidence

Model access to a tool does not imply that a local host can invoke that tool. The supplied TheAliphant account describes connector-only GitHub authority and a successful separate Webhook.site test of 0.1.22. These are motivating user-supplied evidence, not independently reproduced findings in this phase. Credential extraction is neither necessary nor appropriate. A wrapper works only when the host controls the actual callable before its effect.

## Inspected architecture

`tool-call.ts` already validates explicit identity, snapshots strict plain data, binds tool plus args, and delegates to `protectLocal`. `local.ts` supplies the only SQLite ledger, claims, durable receipts, sessions and fail-closed recovery. No changes to these contracts are needed.

Connect already provides `connectLocalAgentTool`, automatic toolsets, OpenAI FunctionTool `invoke` wrapping, and `createMcpExecutionBoundary` around an upstream `callTool`. Gateway planning/binding is a control plane; its local and OpenAI brokers delegate to Connect. Discovery and the OpenAI/Vercel/LangChain observers inventory or record execution, not intercept it. Existing routing/transformer plans are broader reviewed source wiring, not a small callable adapter. Provider reconciliation adapters require application-owned truth and do not infer it universally.

## Seam matrix

| Surface | Before-effect seam / arguments | Tool and authority | Truth / execution ownership | Integration change | Hidden retries / genuine boundary |
|---|---|---|---|---|---|
| Plain callback | replace function or `execute`; plain object input | host explicitly binds tool, account, tenant and target | host owns callable; optional exact read-only lookup | one callback replacement plus semantics | yes before callback; retries inside callback remain opaque |
| MCP client | immediately before `client.callTool({name, arguments})` | name available; configured server/account must be bound explicitly | host owns connected client; truth may be another read-only call | wrap a selected invocation callback; existing catalog boundary remains preferable for full catalogs | yes for host-owned client; transport/server internal retry requires audit |
| OpenAI functions | host resolves selected function and executes parsed arguments | selected name available; call ID is metadata, account supplied by host | host owns local functions; existing FunctionTool adapter handles run context | replace registry callback; use existing adapter for whole FunctionTool objects | yes for local functions; generation wrapping alone does not protect effects |
| Vercel AI SDK | tool definition `execute(input, options)` | registry name available; account supplied by host | local execute owned; lookup application-specific | replace execute callback with unary wrapper when options are diagnostic only | yes for ordinary Promise receipts; streaming results/context-changing effects need explicit normalization |
| LangChain | function passed to `tool`, or application-owned invocation shim | tool name available; account supplied by host | function owned; callbacks/observers are after-the-fact evidence | wrap function at construction; existing instances may require rebuilding | yes for callback; Runnable retries inside opaque implementation excluded |
| Model-side connector | remote execution controlled by platform | visible label does not establish local capability | local host does not own dispatch or credentials | requires platform middleware/host bridge or mediated MCP server | no local SDK interception demonstrated |

Repository examples actually use Vercel `tool({inputSchema, execute})`, LangChain `tool(function, {schema})`, and OpenAI Agents `tool({execute})`; Connect wraps resulting FunctionTool `invoke`. They are distinct from hosted connector execution.

## Decision

Add exactly one public `wrapTool(callback, semantics)` for unary plain-data callbacks. Require synchronous explicit `operationId(input)` and `effect(input)` selectors. Snapshot invocation input before selectors, then let `protectToolCall` snapshot and validate the declared effect. Execute the original callback with **effect.args**, never the unbound original arguments. This makes the declaration the executable input as well as the fingerprint. Capture configuration at construction. Preserve a dynamic receiver for ordinary methods, but developers must bind or fix authority; a mutable receiver/closure is not fingerprinted automatically.

Return original JSON-safe receipts; propagate errors without retry or translation. Optional reconciliation has exactly the existing tool-call signature. No framework dependencies in the runtime, new persistence, versions, migration, classification, identity inference, or reset API.

This differs from existing Connect adapters by requiring explicit tool-call semantics, supporting bare callables, and executing the declared snapshot. Keep existing adapters compatible rather than replacing their classification contracts. Reuse one primitive for selected MCP callbacks; do not add a second catalog boundary or universal proxy.

## Safety and limits

Missing identity/effect fails before dispatch. Account/server/tenant must be in `effect.tool` or `effect.args`; Once cannot determine whether a syntactically valid declaration omitted application semantics. The callback must consume declared args and fixed authority; closure/receiver/provider configuration that changes the effect must be represented or fixed. No automatic inference can solve this.

`UNKNOWN`, negative/error/malformed reconciliation and abandoned claims never authorize another execution. Positive truth must prove the exact declared effect. Immutable snapshots prevent asynchronous caller mutation; they cannot control an opaque callback's hidden retries or external defaults. One callback invocation may still cause multiple provider writes. Disable or audit internal retry layers; use provider idempotency where needed.

Node 24.15+ and one durable SQLite authority remain required. Deleted/rolled-back/split state, multiple hosts, streaming/non-JSON receipts, mutable credential authority and connector-only access are unsupported guarantees.

## Alternatives rejected

### Audited MCP retry boundary

The pinned MCP SDK 1.27.1 `Client.callTool` delegates to a protocol request. Its Streamable HTTP transport can resend the same POST after 401 authentication or 403 insufficient-scope handling, and supports SSE reconnection/resumption. Those mechanisms are not an additional Once claim. The exercised linked in-memory transport has no HTTP authentication or reconnect path. For HTTP deployment, authenticate before enabling the consequential callback, audit the provider's rejection-before-effect contract and transport configuration, and do not claim internal resend protection. The regression intentionally demonstrates that an opaque callback can produce two writes within one Once invocation.

MCP `isError` receipts are returned by the SDK rather than necessarily thrown. This wrapper preserves them as JSON receipts; it does not assert business success or interpret them as proof of absence. If the application throws on an error receipt, the existing conservative UNKNOWN rule applies.

Universal proxy/gateway adds transport, authentication and lifecycle complexity already partly addressed elsewhere. Object cloning/framework subclasses would add compatibility surfaces before need is proven. Variadic opaque context would permit unbound effect inputs; normalize into a plain object or keep effect-independent context in a fixed callback closure. Automatic semantics and force retry undermine the existing safety contract.

## Current primary documentation

- MCP client call seam: https://ts.sdk.modelcontextprotocol.io/client and https://ts.sdk.modelcontextprotocol.io/v2/clients/calling
- Vercel execute seam: https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent
- LangChain tool callable: https://reference.langchain.com/javascript/langchain/index/tool
- OpenAI hosted MCP/connector approval: https://developers.openai.com/api/docs/guides/tools-connectors-mcp

OpenAI exposes approval before remote MCP dispatch, but approval alone does not place a host-supplied execute callback under Once or durably resolve lost acknowledgements. A host-controlled MCP server can mediate its own effects; that is a different deployment. No universal model-side connector middleware was demonstrated.

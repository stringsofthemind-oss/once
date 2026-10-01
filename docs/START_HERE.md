# Start with one protected action

Once wraps consequential application functions and agent tools so retries use
durable knowledge of the original action. You define the intended action's
identity and the inputs that determine its effect. Once replays confirmed
receipts, rejects changed effects and blocks uncertain outcomes.

Use Once when an external write can be retried, its acknowledgement can be lost,
and duplication matters. Provider-native idempotency may already cover a simple
integration. Use it where available; Once does not replace the provider's
guarantees or your application's authorization checks.

## First controlled proof

The currently published TypeScript SDK is **0.1.22**. Local execution needs
**Node.js 24.15+**; the hosted HTTP client has a different runtime boundary.

In a throwaway directory, these commands work in PowerShell and POSIX shells:

```sh
npm init -y
npm install @once-agent/sdk@0.1.22
npx once prove
```

No Once API key or provider credentials are required. The proof uses a simulated
provider and isolated temporary state. It demonstrates a committed effect with
a lost acknowledgement, a blocked retry, recovery and confirmed replay. It does
not establish that your application's tools are protected or that a real
provider can reconcile. Five minutes is an onboarding target, not a measured
human completion-time guarantee.

## Protect your existing function

```ts
import { Once, protectLocal } from "@once-agent/sdk";

const createOrder = protectLocal(
  async (input) => provider.createOrder({
    account: input.account,
    sku: input.sku,
    quantity: input.quantity,
  }),
  {
    // Persist intentId BEFORE dispatch. Reuse it for every retry/restart.
    // A separate intended order gets a separate intent, even for the same SKU.
    id: (input) => Once.id("production", input.account, "create-order", input.intentId),
    payload: (input) => ({
      account: input.account,
      sku: input.sku,
      quantity: input.quantity,
    }),
    statePath: "/persistent/local/path/operations.sqlite",
  },
);
```

Replace the state path with a persistent absolute path on your machine; on
Windows, for example, use `C:/your-project/.once/operations.sqlite`. All
cooperating processes must use the same file. The provider account/configuration
must correspond to the bound account and remain stable during a call.

Return a JSON-safe receipt that represents the provider outcome you intend to
confirm. Do not return an SDK response object, stream or credential. An accepted
queued job is not proof of the job's final effect. Route all calls through the
wrapper; internal provider retries and multiple effects inside one function need
their own reviewed provider semantics.

The [canonical source example](../sdk/typescript/examples/first-action/verify.mjs)
counts simulated effects for first execution, replay, changed-effect conflict,
distinct intent with identical effect, lost acknowledgement, unavailable truth,
recovery and fresh-process replay. Run it from a built source checkout using
`node examples/local-function/verify.mjs`. That source example and its package
inclusion are branch changes; public 0.1.22 consumers can use `once prove` now.

## Choose your path

- Existing function on one machine: [local function guide](../examples/local-function/README.md).
- Agent tool registry or OpenAI function tools: [Connect](CONNECT_AUTO.md).
  Give the agent only the connected tools. Trusted application code supplies
  the persisted intent; a model-generated call ID is not business identity.
- MCP: [MCP guide](../mcp/README.md). Setup/discovery is separate from runtime
  enforcement; installation alone does not protect arbitrary tool calls.
- Existing project discovery: `npx once doctor .`, then review `npx once protect .`.
  Applying a supported patch is an explicit separate step. Never reshape an
  action's business meaning to satisfy a transformer.
- Multiple hosts: inspect [guarantees](GUARANTEES.md) and
  [production operation](PRODUCTION_OPERATION.md) before choosing a backend.

## Documentation map

1. What is Once? This guide's introduction.
2. Why does it exist? Ambiguous external writes, described above.
3. Five-minute target: [controlled proof](#first-controlled-proof); human timing unverified.
4. Identity: [application ownership](IDENTITY_AND_EFFECT.md).
5. Effect binding: [effect review](IDENTITY_AND_EFFECT.md#effect-review).
6. Replay: [local execution contract](../examples/local-function/README.md).
7. Conflict: [caller outcomes](UNKNOWN_PLAYBOOK.md#safe-application-response).
8. UNKNOWN: [playbook](UNKNOWN_PLAYBOOK.md).
9. Recovery: [original receipt](UNKNOWN_PLAYBOOK.md#recover-the-original-receipt).
10. Provider adapters: [reconciliation contract](../sdk/typescript/src/reconciliation/CONTRACT.md).
11. Agent integration: [Connect](CONNECT_AUTO.md).
12. MCP: [MCP guide](../mcp/README.md).
13. CLI: [CLI reference](../sdk/typescript/README.md#cli-workflow).
14. Guarantees: [matrix](GUARANTEES.md).
15. Limitations: [authority continuity](AUTHORITY_CONTINUITY.md) and guarantee boundaries.
16. Production operation: [runbook](PRODUCTION_OPERATION.md).
17. API reference: [TypeScript SDK](../sdk/typescript/README.md#api-overview) and [Python SDK](../sdk/python/README.md).
18. Architecture: [local boundary](../examples/local-function/README.md),
    [hosted contract](GATEWAY_HOSTED_TRANSPORT_V1.md) and
    [hosted readiness](GATEWAY_HOSTED_PRODUCTION_READINESS_V1.md).

Historical evidence and phase records remain available for reproducibility.
They do not override current adapter or deployed-service boundaries.

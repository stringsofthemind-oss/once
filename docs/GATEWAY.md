# Once Gateway

Status: repository `main` release candidate. The currently published npm package remains `@once-agent/sdk@0.1.11` until a later SDK release is explicitly versioned and published.

The Once Gateway selectively routes an agent/runtime's **already-selected tool subset** without copying the global Tool Graph into model context.

Its routing model is deliberately small:

- `DIRECT` — duplicate-effect protection does not apply; call the original implementation.
- `PROTECT` — the tool is consequential; use the existing Once Connect/protection path.
- `BLOCK` — routing safety is unresolved or conflicting; do not invoke the tool.

There is no automatic `BLOCK -> DIRECT` fallback.

## Local toolset

```ts
import {
  connectLocalGatewayToolsetAuto,
} from "@once-agent/sdk/gateway";

const gateway = connectLocalGatewayToolsetAuto(
  {
    search_orders: {
      async execute(input: { query: string }) {
        return searchOrders(input.query);
      },
    },
    send_email: {
      async execute(input: {
        idempotencyKey: string;
        destination: string;
        body: string;
      }) {
        return mailer.send({
          to: input.destination,
          body: input.body,
        });
      },
    },
  },
  {
    manifest: [
      {
        name: "search_orders",
        description: "Search customer orders",
      },
      {
        name: "send_email",
        description: "Send an external customer email",
        _meta: {
          once: {
            effectFields: ["destination", "body"],
          },
        },
      },
    ],
    statePath: ".once/gateway.sqlite",
  },
);

// Expose only the returned registry to the runtime/agent.
const toolsForAgent = gateway.tools;
```

For that selected subset, `search_orders` can remain direct while `send_email` is routed through the existing Once protection engine. An unresolved tool prevents the subset from being partially wired.

## Planning without execution

```ts
import {
  planGatewayToolset,
} from "@once-agent/sdk/gateway";

const plan = planGatewayToolset(manifest);

for (const entry of plan.entries) {
  console.log(entry.name, entry.route);
}
```

Planning is control-plane only. It does not invoke tools, open protection state, contact providers/MCP servers, or resolve per-invocation operation identity/payload.

## Exact Tool Graph binding

Gateway routing can optionally be bound to Phase 11 Tool Graph identity records.

Binding requires an exact canonical tool name **and** the descriptor fingerprint used by the Gateway planner. Missing, stale, or duplicate exact identity fails closed rather than falling back to name-only matching.

Tool Graph evidence such as `MODEL_VISIBLE` or `EXECUTED` can increase confidence/action priority, but it never weakens routing. An `EXECUTED` consequential tool still remains `PROTECT`.

The caller may supply a larger/global binding set. Only the runtime-selected manifest entries appear in the returned bound plan; unrelated Tool Graph entries are not injected into model context.

## OpenAI Agents FunctionTools

```ts
import {
  connectOpenAIAgentsFunctionToolsGatewayAuto,
} from "@once-agent/sdk/gateway";

const connected = connectOpenAIAgentsFunctionToolsGatewayAuto(
  agentTools,
  {
    statePath: ".once/openai-gateway.sqlite",
  },
);

// Give the Agent the returned FunctionTools, in the same order/subset.
const toolsForAgent = connected.tools;
```

The adapter is structural: Once does not require `@openai/agents` as a runtime dependency. Phase 11E v1 supports FunctionTools in this adapter; hosted/computer/shell/apply-patch/MCP and other OpenAI tool categories are not silently passed through.

OpenAI transport/tool-call IDs are not treated as logical Once intent identity. Protected retries must resolve a stable intent from trusted tool input/Once metadata or an explicit override.

## Failure semantics

The Gateway fails closed before an external effect when it cannot safely establish the route or the existing protection path cannot establish required execution facts.

Examples include:

- unknown/conflicting tool semantics -> `BLOCK`;
- exact Tool Graph fingerprint mismatch -> `BLOCK`;
- protected tool with no trustworthy logical operation identity -> existing `IDENTITY_REQUIRED` failure;
- conflicting identity carriers -> existing `IDENTITY_CONFLICT` failure;
- protected tool with no safe effect payload -> existing `PAYLOAD_REQUIRED` failure;
- same logical identity with changed effect payload -> existing conflict behavior;
- ambiguous provider outcome -> existing reconciliation/uncertainty behavior.

A protection failure never causes automatic direct execution.

## Runtime boundary

Gateway planning and direct routing are lightweight. Local protected execution uses the existing same-machine Once SQLite path and therefore requires Node.js 24.15+.

This local Gateway does **not** claim multi-host exactly-once execution. Multi-host/shared protection requires a future shared/remote protection boundary.

## Design invariant

> The Gateway decides **how** an already-selected tool invocation is routed. It does not silently decide **that** a consequential action is authorized, and uncertainty never becomes direct execution.

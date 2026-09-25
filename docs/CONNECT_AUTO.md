# Once Connect — automatic tool protection

> **Release-candidate status:** the automatic Connect APIs are implemented on
> repository `main` and have passed source, packed-package, ESM/CommonJS, and
> Node.js 24.15 protected-execution release gates. The currently published npm
> package remains `@once-agent/sdk@0.1.11` until the next SDK release is
> explicitly versioned and published.

Once Connect moves the integration boundary from:

> “the developer decides which calls need Once and wires each one manually”

Toward:

> “give Once the agent's tools; Once separates safe bypasses from consequential
> operations and fails closed when it cannot prove what to do.”

The current automatic TypeScript path is local/same-machine protection backed by
SQLite. Local protected execution requires **Node.js 24.15 or later**. It is not
multi-host coordination.

## Decision model

Automatic Connect classifies each tool as:

- `BYPASS` — obvious read/search/generation-only work;
- `PROTECT` — obvious consequential external-state mutation;
- `UNKNOWN` — insufficient or conflicting evidence.

`UNKNOWN` is never treated as permission to bypass Once.

For a protected invocation, Once also needs two independent bindings:

1. **logical operation identity** — the same intentional real-world action must
   resolve to the same identity on every retry;
2. **effect payload** — every value that can change the external effect must be
   bound to that identity.

A retry transport ID, framework tool-call ID, timestamp, or whole-payload hash is
not automatically considered logical intent identity.

## Whole local tool registry

```ts
import {
  connectLocalAgentToolsetAuto
} from "@once-agent/sdk/connect";

const originalTools = {
  search_web: {
    async execute(input: { query: string }) {
      return search(input.query);
    }
  },

  send_email: {
    async execute(input: {
      intentId: string;
      destination: string;
      body: string;
    }) {
      return mailer.send({
        to: input.destination,
        body: input.body
      });
    }
  }
};

const manifest = [
  {
    name: "search_web",
    description: "Search the public web."
  },
  {
    name: "send_email",
    description: "Send an email to a recipient.",
    _meta: {
      once: {
        identityFields: ["intentId"],
        effectFields: ["destination", "body"]
      }
    }
  }
];

const connected = connectLocalAgentToolsetAuto(
  originalTools,
  {
    manifest,
    statePath: ".once/agent-tools.sqlite"
  }
);

console.log(connected.plan.summary);

// Give the agent ONLY connected.tools.
// Do not also expose originalTools as another capability.
const toolsForAgent = connected.tools;
```

Toolset connection is all-or-nothing. It rejects:

- an invalid manifest;
- an `UNKNOWN` tool decision;
- duplicate tool names;
- a manifest tool with no same-named implementation;
- an executable implementation absent from the manifest;
- an invalid implementation;
- an override for an undeclared tool.

The input registry is not mutated. Once returns a separate connected registry.

## Identity

Once can resolve common explicit intent carriers such as operation,
idempotency, or intent keys. A descriptor can also declare composite identity
fields:

```ts
_meta: {
  once: {
    identityFields: ["customerId", "checkoutId"]
  }
}
```

Use fields that identify **one intentional business action**, not one network or
model attempt.

### Good identity property

If attempt 1 times out and attempt 2 is a retry of the same intended action,
the identity fields remain unchanged.

### Bad identity property

Do not use values that naturally change on retry, for example:

- `toolCallId`;
- `requestId`;
- `Date.now()`;
- a random UUID generated for every attempt.

Do not choose a business key that would incorrectly collapse two legitimately
separate intentional actions into one operation.

## Effect payload

For protected tools, prefer explicitly declaring the fields that determine the
external effect:

```ts
_meta: {
  once: {
    effectFields: ["destination", "body"]
  }
}
```

If explicit effect fields are unavailable, automatic local routing can use a
conservative full-input payload when the input is supported JSON-safe plain
data. That fallback deliberately includes fields rather than guessing they are
transport-only.

As a result, a retry-only field changing between attempts can cause payload
drift and block the retry. That is safer than silently dropping a field that
might alter the side effect. Use `effectFields` when the boundary is known.

## OpenAI Agents FunctionTool integration

The current OpenAI Agents JS/TS SDK exposes function tools with `name`,
`description`, `parameters`, and an `invoke(runContext, input, details?)`
boundary. Automatic Connect wraps that boundary structurally and does not add
`@openai/agents` as an SDK runtime dependency.

```ts
import {
  Agent,
  tool
} from "@openai/agents";
import { z } from "zod";

import {
  connectOpenAIAgentsFunctionToolsAuto
} from "@once-agent/sdk/connect";

const searchTool = tool({
  name: "search_web",
  description: "Search the public web.",
  parameters: z.object({
    query: z.string()
  }),
  async execute({ query }) {
    return search(query);
  }
});

const sendEmailTool = tool({
  name: "send_email",
  description: "Send an email to a recipient.",
  parameters: z.object({
    intentId: z.string(),
    destination: z.string(),
    body: z.string()
  }),
  async execute({ destination, body }) {
    return mailer.send({
      to: destination,
      body
    });
  }
});

const connected = connectOpenAIAgentsFunctionToolsAuto(
  [searchTool, sendEmailTool],
  {
    statePath: ".once/openai-agent.sqlite",
    overrides: {
      send_email: {
        _meta: {
          once: {
            identityFields: ["intentId"],
            effectFields: ["destination", "body"]
          }
        }
      }
    }
  }
);

const agent = new Agent({
  name: "Safe agent",
  instructions: "Use the available tools when needed.",
  tools: [...connected.tools]
});
```

The wrapper preserves the original FunctionTool fields and passes the original
raw JSON input, run context, and tool-call details to the original `invoke`
when execution is allowed.

OpenAI tool-call details are **not** used as Once logical operation identity.
Framework call IDs can change when an agent retries the same real-world action.

### FunctionTool-only v1

`connectOpenAIAgentsFunctionToolsAuto()` currently accepts OpenAI Agents
**FunctionTool** objects only.

It fails closed on hosted, computer, shell, apply-patch, MCP, or other tool
categories instead of silently returning a partially protected tool list.
Those categories need adapters that understand their own execution boundaries.

## Overrides are escape hatches, not required ceremony

When automatic metadata is not enough, per-tool overrides can supply:

- safety annotations;
- `_meta.once.identityFields`;
- `_meta.once.effectFields`;
- a custom `id(input)` selector;
- a custom `payload(input)` selector;
- `statePath`;
- authoritative `reconcile` logic.

For straightforward tools with trusted intent carriers and JSON-safe effect
inputs, no manual `id()` or `payload()` callback is required.

## Ambiguous outcomes

Automatic classification and identity do not eliminate distributed-systems
uncertainty.

If an external effect may have happened but the acknowledgement was lost, Once
must not infer `ABSENT` from a timeout. A real provider integration should use a
read-only authoritative reconciliation lookup where possible. Otherwise an
uncertain operation must remain blocked rather than be blindly redispatched.

## Local-mode boundary

This automatic path currently delegates to Once local protection:

- durable SQLite state;
- same-machine coordination;
- confirmed replay / conflict detection;
- fail-closed ambiguous handling.

Do not present this local path as multi-host exactly-once execution. A
multi-process or multi-host architecture needs a supported shared/durable
integration appropriate to that deployment.

## Release validation

The automatic Connect release candidate has been tested at three layers:

1. source-tree classifier, identity, payload, registry, and framework regressions;
2. a clean `npm pack` consumer proving TypeScript, ESM, and CommonJS
   `@once-agent/sdk/connect` imports;
3. a clean Node.js 24.15 consumer installing the packed artifact and proving one
   protected effect, confirmed replay without a second effect, changed-payload
   conflict blocking, and durable SQLite state.

## Current integration ladder

The automatic Connect stack now provides:

```text
tool descriptor
    ↓
PROTECT | BYPASS | UNKNOWN
    ↓
whole-manifest protection plan
    ↓
whole-registry fail-closed wiring
    ↓
logical operation identity resolution
    ↓
consequential payload binding
    ↓
existing Once local safety engine
    ↓
framework-native OpenAI FunctionTool wrapper
```

The design rule remains simple:

> **One intentional consequential action should produce one consequential
> external effect across retries, or Once should block rather than guess.**

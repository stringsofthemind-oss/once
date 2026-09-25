# Connect an agent's existing tool to Once

The application connects a tool **once** and gives the resulting `bookingTool`
to its chosen agent or tool host. The agent calls `bookingTool.execute(input)`
normally; it does not have to decide to call Once on each invocation. Once uses
the reviewed four-condition declaration to route this tool through its local
protection boundary. A second intended booking with identical details uses a
different intent ID and is allowed.

This is a **source-checkout demonstration** of the `connectLocalAgentTool` API.
From the repository root, on Node.js 24.15 or later:

```bash
cd sdk/typescript
npm ci
npm run build
cd ../..
node examples/connected-agent-tool/verify.mjs
```

The program expects **three agent calls, two intentional bookings, two fake
provider effects, and a blocked payload conflict**. The example uses a fake
provider and a temporary SQLite file; no booking service or payment system is
contacted. The application must give the agent only the connected tool. Any
separate direct route to the original provider bypasses this protection.

Before registering a real tool, its owner must review whether it changes
external state, may be retried, can have an ambiguous outcome, and could cause
an undesirable duplicate. For a protected tool, `id` must identify one
intentional effect across agent retries, while `payload` must include every
effect-changing input. These facts cannot reliably be inferred from an LLM's
text or a fresh model tool-call ID. Incomplete declarations or missing
selectors reject the connection.

This local path coordinates callers using the **same durable SQLite file on
one machine**. Node.js 24.15+ is required. For uncertain outcomes it blocks
retry; it cannot promise that every task will complete without a provider
lookup. A read-only `reconcile` callback can confirm an effect only when the
external provider supplies authoritative truth. An `ABSENT` observation does
not authorize local redispatch. Hosts on separate machines need a supported
hosted provider integration and shared execution-safety state.

MCP assessment tools can help an agent discover that Once is relevant, but
installing an MCP server does not transparently intercept its production
tools. Connect the actual tool at the application/tool-host execution boundary.

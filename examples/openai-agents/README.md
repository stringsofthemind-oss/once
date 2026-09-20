# Once + OpenAI Agents

Protect consequential OpenAI Agents tool calls from unsafe duplicate execution after ambiguous failures and retries.

## The failure mode

An AI agent calls a refund tool.

The provider performs the refund.

The response is lost.

The agent or application retries.

Without stable operation identity and provider reconciliation, the same real-world refund may be executed again.

## The Once pattern

```js
const operationId = Once.id(
  "refund",
  orderId
);

await once.execute({
  operationId,
  provider,
  action: {
    type: "refund",
    order_id: orderId
  }
});
```

The important rule:

> A retry of the same logical operation must reuse the same operation ID.

## Install

Requires Node.js 22 or later for the current OpenAI Agents SDK.

```bash
npm install
```

Copy the environment template:

```powershell
Copy-Item .env.example .env
```

Configure:

```text
OPENAI_API_KEY=...
ONCE_API_KEY=...
ONCE_PROVIDER_ALIAS=...
```

The provider alias must refer to a supported provider configured with Once.

## Run

```bash
npm start
```

Or choose an order ID:

```bash
npm start -- order_4821
```

The example asks the OpenAI agent to perform the same logical refund twice.

Both calls derive their identity from:

```js
Once.id("refund", orderId)
```

so a retry does not become a new logical operation merely because the agent called the tool again.

## What Once does

Once combines:

- stable operation identity
- durable operation state
- supported provider execution
- provider reconciliation
- conservative handling of uncertain outcomes

Once does not claim universal exactly-once execution.

Its safety properties depend on the configured provider integration and the authority of provider truth available for reconciliation.

## Links

- Once: https://onceexec.pages.dev/
- AI agent retry safety: https://onceexec.pages.dev/ai-agent-retry-safety/
- npm: `@once-agent/sdk`
- MCP: `@once-agent/mcp`
# Once + LangChain / LangGraph

Protect consequential LangChain and LangGraph agent tool calls from unsafe duplicate execution after ambiguous failures and retries.

## The problem

An agent tool performs a refund, payment, booking or another external write.

The external provider completes the action, but the response is lost.

The agent retries.

Without stable operation identity and reconciliation, the same real-world action may be executed twice.

## Safe tool pattern

```js
const refundOrder = tool(
  async ({ orderId }) => {
    const operationId = Once.id("refund", orderId);

    return once.execute({
      operationId,
      provider,
      action: {
        type: "refund",
        order_id: orderId
      }
    });
  },
  {
    name: "refund_order",
    description: "Refund an order safely.",
    schema: z.object({
      orderId: z.string()
    })
  }
);
```

The important property is that retries of the same logical refund reuse:

```js
Once.id("refund", orderId)
```

## Install

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
OPENAI_MODEL=...
ONCE_API_KEY=...
ONCE_PROVIDER_ALIAS=...
```

## Run

```bash
npm start
```

Or:

```bash
npm start -- order_4821
```

LangChain agents are built on LangGraph, so the same execution-safety pattern applies when consequential tools are orchestrated through LangGraph workflows.

Once does not claim universal exactly-once execution. Safety depends on stable operation identity, durable Once state, the configured provider integration and sufficiently authoritative provider truth.

## Links

- Once: https://onceexec.pages.dev/
- AI agent retry safety: https://onceexec.pages.dev/ai-agent-retry-safety/
- SDK: `@once-agent/sdk`
- LangChain: https://www.langchain.com/
# Once + Vercel AI SDK

Protect consequential Vercel AI SDK tool calls from unsafe duplicate execution after ambiguous failures and retries.

## Why

AI SDK tools can perform real-world writes such as refunds, payments and bookings.

If the provider performs the action but the response is lost, blindly executing the tool again can duplicate the side effect.

## Safe tool pattern

```js
const refundOrder = tool({
  inputSchema: z.object({
    orderId: z.string()
  }),

  async execute({ orderId }) {
    const operationId = Once.id("refund", orderId);

    return once.execute({
      operationId,
      provider,
      action: {
        type: "refund",
        order_id: orderId
      }
    });
  }
});
```

The same logical refund receives the same operation ID on every retry.

## Install

Requires Node.js 22 or later.

```bash
npm install
```

Copy the environment template:

```powershell
Copy-Item .env.example .env
```

Configure:

```text
AI_GATEWAY_API_KEY=...
ONCE_API_KEY=...
ONCE_PROVIDER_ALIAS=...
```

## Run

```bash
npm start
```

Or specify an order:

```bash
npm start -- order_4821
```

Running the same logical operation again reuses:

```js
Once.id("refund", orderId)
```

Once does not claim universal exactly-once execution. Safety depends on stable operation identity, durable Once state, the configured provider integration and sufficiently authoritative provider truth.

## Links

- Once: https://onceexec.pages.dev/
- AI agent retry safety: https://onceexec.pages.dev/ai-agent-retry-safety/
- SDK: `@once-agent/sdk`
- Vercel AI SDK: https://ai-sdk.dev/
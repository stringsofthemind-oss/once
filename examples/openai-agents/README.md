# Once + OpenAI Agents

Protect consequential OpenAI Agents tool calls from unsafe duplicate execution after ambiguous failures and retries.

## The failure mode

An AI agent calls a refund tool.

The provider performs the refund.

The response is lost.

The agent or application retries.

Without stable operation identity and provider reconciliation, the same real-world refund may be executed again.

## The Once pattern

The OpenAI Agents tool crosses the Once Connect boundary:

```js
const operationId = Once.id(
  "refund",
  orderId
);

const result =
  await executeOpenAIAgentsConnectTool({
    once,
    provider,
    safety: {
      changesExternalState: true,
      retryPossible: true,
      ambiguousOutcomePossible: true,
      duplicateUndesirable: true
    },
    operationId,
    input: {
      orderId
    },
    action: {
      type: "refund",
      order_id: orderId
    }
  });
```

The adapter routes consequential tool calls through Once Connect before they reach the existing Once execution kernel.

The logical operation identity is derived from the real-world refund, not from an individual model tool-call ID. That means a retry can refer to the same operation.

## Run the example

Configure `ONCE_PROVIDER_ALIAS` for a supported Once provider, then run:

```powershell
npm install
npm start order_123
```

The example sends the same logical refund request twice so the integration can be observed across an initial request and a retry.

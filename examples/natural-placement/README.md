# Natural placement (SDK 0.1.24)

Requires Node.js 24.15+. Install the published SDK in your application:

```bash
npm install @once-agent/sdk
```

`wrapTool` is available in SDK 0.1.24.

`host-callback.mjs` and `mcp-client.mjs` are reusable integration examples. Copy them into an application that has installed SDK 0.1.24 or later and supply its fixed host/client and authoritative lookup.

## Ordinary host callback

```js
import { wrapTool } from '@once-agent/sdk';

const protectedSend = wrapTool(sendMessage, {
  statePath: './durable/once.sqlite',
  operationId: ({ orderId }) => `order:${orderId}:send`,
  effect: ({ orderId, message }) => ({
    tool: 'messaging.account-A.send',
    args: { orderId, message },
  }),
  reconcile: async ({ effect }) => readExactMessage(effect),
});

await protectedSend({ orderId: 'order-123', message: 'Synthetic test' });
```

`sendMessage` receives the deeply frozen `effect.args`. Choose a new operation ID for a new intentional send. `readExactMessage` must return `{status:'CONFIRMED', result: receipt}` only for authoritative exact evidence, otherwise `{status:'NOT_FOUND'}` or `{status:'UNKNOWN'}`. Negative truth does not permit retry.

## Existing MCP client

```js
const protectedAppend = wrapTool(
  args => client.callTool({ name: 'append', arguments: args }),
  {
    statePath: './durable/once.sqlite',
    operationId: ({ intent }) => intent,
    effect: ({ intent, body }) => ({
      tool: 'mcp.configured-server.account-A.append',
      args: { intent, body },
    }),
    reconcile: async ({ effect }) => lookupExactAppend(client, effect),
  },
);
await protectedAppend({ intent: 'append-123', body: 'Synthetic test' });
```

Keep the client connected to the fixed server/account declared above. Audit client/transport/server retries. A real MCP SDK 1.27.1 client/server regression executes initialization, tools/list, tools/call and read-only lookup using linked protocol transports; it independently counts server mutations. It is a local protocol proof, not public-provider evidence. Use existing `createMcpExecutionBoundary` for a classified full tool catalog.

## Framework placement

For Vercel, use `{ ...definition, execute: wrapTool(definition.execute, semantics) }` only when the second execute options argument does not change the effect; bind a receiver if the method needs one. For LangChain, pass `wrapTool(callback, semantics)` to the framework's `tool` constructor. For OpenAI function calling, put the wrapped function in the host dispatch registry; model call IDs remain metadata. Existing OpenAI Agents FunctionTool objects have a dedicated Connect adapter.

The tests in `sdk/typescript/test/wrap-tool.test.mjs` and `wrap-tool-mcp.test.mjs` are executable examples: run `npm run test:wrap-tool` in the SDK directory.

The callback must use declared arguments and fixed authority. Mutable closures, provider defaults, effect-changing context, internal retries, streaming receipts, deleted/rolled-back state and split hosts require additional review. One opaque callback can write twice; Once cannot prevent that. Return JSON-safe receipts and share one durable SQLite file across retries/processes. Model-side connector access without a host callable remains unsupported.

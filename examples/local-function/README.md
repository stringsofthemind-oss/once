# Protect an existing async function on one machine

This example uses the **source checkout** of the TypeScript SDK. `protectLocal`
is not part of the published `@once-agent/sdk` 0.1.6 package yet.

```ts
import { protectLocal } from "@once-agent/sdk";

// Keep the application's existing call shape. The provider receives the
// same arguments; only the function implementation is wrapped.
const createOrder = protectLocal(
  async ({ provider, orderId, amountCents }) =>
    provider.createOrder({ orderId, amountCents }),
  {
    id: ({ orderId }) => `create-order:${orderId}`,
    payload: ({ orderId, amountCents }) => ({ orderId, amountCents }),
  },
);

// Existing callers still call createOrder({ provider, orderId, amountCents }).
```

If the existing application builds a tool with `createOrderTool({ provider })`,
keep that factory signature and wrap its async operation inside the factory:

```ts
function createOrderTool({ provider }) {
  return {
    execute: protectLocal(
      input => provider.createOrder(input),
      {
        id: input => `create-order:${input.orderId}`,
        payload: input => ({ orderId: input.orderId, amountCents: input.amountCents }),
      },
    ),
  };
}
```

Existing callers can still use `createOrderTool({ provider })` and then
`tool.execute(input)`; the provider object does not need a new alias.

The default state file is `.once/operations.sqlite` under the process's
working directory, resolved when the wrapper is created. Keep that directory
durable and shared by every process on the **same machine** that can call this
operation. Set `statePath` to an explicit persistent path when the working
directory can change. Node.js 24.15 or later is required for this local path.

The `id` must identify one *intentional* external action across retries,
restarts, framework replay, and regenerated tool-call IDs. Two intentional
orders of the same amount need distinct IDs. Namespace IDs by action type and
tenant or account when appropriate. The `payload` must include every
input that changes the external effect. Reusing an ID with changed payload
fails with `CONFLICT`. Exclude transport-only values such as a request ID.

The function must return a JSON-safe result to enable durable replay. A
resolved result must represent a confirmed external outcome; a queued job
acknowledgement is not proof that the job executed. If the function throws,
crashes, or returns an unreplayable result after dispatch, the state is
`UNKNOWN`. A retry will not call the function again. You can supply
`reconcile({ id, payload })` to look up **authoritative** provider truth and
return `{ state: "CONFIRMED", result: ... }`. A timeout, stale read, or missing
record in a provider that does not guarantee authoritative absence is not
proof of `ABSENT`. Even an authoritative `ABSENT` observation does not trigger
redispatch in this conservative local path: an earlier in-flight write might
still commit. Use a provider integration with durable idempotency for that
recovery behavior.

Local SQLite coordinates processes using the same file on one host. It does
not coordinate separate hosts, containers with separate filesystems, or
regions. Deleting the file, using a volatile filesystem, or changing its path
loses protection. No arbitrary external system and local SQLite file share an
atomic transaction.

Route every consequential call through the wrapped function. A direct call to
the original provider method from another code path bypasses this boundary.

To verify, use a test provider that counts actual external effects. Invoke
`A / $100` twice, `B / $100` once, then `A / $125`. The expected count is
**2**, with the last call raising `CONFLICT`. Also commit an effect then drop
its response: a retry must remain blocked until provider truth confirms it.

The runnable [`verify.mjs`](./verify.mjs) is a controlled first proof. Install
the source package in a throwaway Node project, copy `verify.mjs` there, and
run `node verify.mjs`. It checks the actual fake provider effect count.

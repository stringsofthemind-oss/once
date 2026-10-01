# Protect an existing async function on one machine

`protectLocal` was introduced in the published `@once-agent/sdk` 0.1.7 package
and remains part of the current SDK. This guide covers its durable same-machine
SQLite safety boundary.

```ts
import { protectLocal } from "@once-agent/sdk";

// Keep the application's existing call shape. Ordinary data arguments are
// snapshotted; the provider handle keeps its identity.
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
input that changes the external effect. Reusing an ID with a different
supported payload fails with `CONFLICT`. Unsupported data fails validation
before claim creation. Exclude transport-only values such as a request ID.
The `id` and `payload` selectors must be pure and must not perform external
writes. The `reconcile` callback must be a read-only provider lookup.

The local payload and receipt domain supports finite numbers except negative zero,
strings, booleans, null, dense ordinary arrays without extra properties, and
plain objects with enumerable own data properties. Nested `undefined`,
accessors, `toJSON` hooks, symbol or hidden properties, sparse or extended
arrays, cycles, proxies, and class instances are rejected. The Connect fingerprint
format is unchanged. Ordinary data arguments are copied and frozen before the
first await, so later caller mutation cannot change dispatch or reconciliation
values. Dynamic `this` and provider/function handles keep their identity;
callers must keep effect-bearing state on those opaque handles stable until
completion. The wrapped function must use the selected snapshotted values for
its external effect.

The function must return a supported plain-data result to enable durable
replay; top-level `undefined` is also allowed. The first successful caller
and retries receive data decoded from the same persisted representation. A
resolved result must represent a confirmed external outcome; a queued job
acknowledgement is not proof that the job executed. If the function throws or
returns an unreplayable result after dispatch, the state is `UNKNOWN`. A
crash leaves a claim that becomes `UNKNOWN` on a retry after lease expiry;
an earlier retry sees `IN_FLIGHT`. A retry will not call the function again.
You can supply `reconcile({ id, payload })` to look up **authoritative** provider truth and
return `{ state: "CONFIRMED", result: ... }`. A timeout, stale read, or missing
record in a provider that does not guarantee authoritative absence is not
proof of `ABSENT`. Even an authoritative `ABSENT` observation does not trigger
redispatch in this conservative local path: an earlier in-flight write might
still commit. Use a provider integration with durable idempotency for that
recovery behavior.

Local SQLite coordinates cooperating processes using the same durable file on
one host and a filesystem supporting SQLite locks and WAL. Network filesystems
are unsupported. It does not coordinate separate hosts, containers with separate filesystems, or
regions. Deleting the file, using a volatile filesystem, or changing its path
loses protection. No arbitrary external system and local SQLite file share an
atomic transaction.

Route every consequential call through the wrapped function. The wrapper
controls its own dispatches. A direct call to the original provider method,
internal retries, or multiple external effects inside one wrapped invocation
bypass this one-dispatch boundary.

To verify, use a test provider that counts actual external effects. Invoke
`A / $100` twice, `B / $100` once, then `A / $125`. The expected count is
**2**, with the last call raising `CONFLICT`. Also commit an effect then drop
its response: a retry must remain blocked until provider truth confirms it.

## Run the canonical source proof

From a source checkout with Node.js 24.15+:

```sh
cd sdk/typescript
npm ci
npm run build
cd ../..
node examples/local-function/verify.mjs
```

The entry point delegates to one canonical SDK example. It persists simulated
intent before dispatch, counts first execution/replay and conflict, permits a
separate intent with identical effect, blocks UNKNOWN when truth is unavailable,
recovers by exact provider evidence, then replays from a fresh process.
Expected final count: **3 simulated effects** for three distinct intents.
The proof uses a new isolated temporary directory and removes only that fixture.
It calls no real provider and modifies no application project files.

For the **currently published 0.1.22 package**, use the existing
`npx once prove` command after installation. The expanded source example is a
review-branch addition; its inclusion in a future package requires release approval.
Historical v0.1.9 proofs remain reproducible from the v0.1.9 tag.

See [Start here](../../docs/START_HERE.md),
[identity/effect](../../docs/IDENTITY_AND_EFFECT.md),
[UNKNOWN](../../docs/UNKNOWN_PLAYBOOK.md) and
[guarantees](../../docs/GUARANTEES.md).

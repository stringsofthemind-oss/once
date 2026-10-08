# Registered local-test order action

This is an **opt-in helper in MCP 0.2.0**, not a new default plugin tool. It
supports one reviewed unary action in the `disposable-orders` / `local-test`
boundary. The test host owns an authenticated loopback HTTP client. A different
provider or a production action needs a separately reviewed adapter; this helper
does not invoke arbitrary installed connectors.

## Public API

```ts
import { registerProtectedOrderAction } from '@once-agent/mcp/registered-action';

const registration = await registerProtectedOrderAction(server, {
  name: 'once_create_order', // optional, fixed host alias
  authority: {
    provider: 'disposable-orders', accountId: 'account-A', environment: 'local-test',
  },
  resourceId: 'orders-local',
  statePath: '/absolute/persistent/operations.sqlite',
  authorize: trustedHostAdmissionAndReceiptAccessCheck,
  provider: authenticatedHostOwnedClient,
});
// Connect the MCP server only after registration succeeds.
// After stopping the server: registration.close();
```

The exported types are `OrderAuthority`, `PreparedOrderEffect`, `OrderReceipt`,
`RegisteredOrderProvider`, and `RegisteredOrderOptions`. Existing SDK signatures
and state transitions are unchanged. No SDK source change is needed.

Host callbacks are executable capabilities supplied by trusted installed code,
never by tool input. The provider implements:

* `assertAuthority()` — verify the actual authenticated account/environment.
* `create(preparedEffect, operationId)` — execute one write using the exact
  immutable prepared provider arguments. Map the separate identity to the
  provider's durable correlation reference. No hidden write retries.
* `lookup(operationId)` — read-only authoritative observation under the same
  account, with no create fallback.

The host must authorize each invocation, including receipt replay, and keep the
client's principal fixed throughout dispatch and lookup. Registration captures
the methods, configuration and admission callback. Authority is checked at
registration, before ledger access, and around execution/reconciliation. These
checks rely on the reviewed host capability; they cannot attest to malicious
host code or prevent an undisclosed account switch inside that capability.

## Agent schema and flow

```json
{"operationId":"task-7/order-intent-1","args":{"sku":"SKU-1","quantity":2,"destinationId":"address-1"}}
```

Both outer input and inner arguments reject extra keys. SKUs are `SKU-1` or
`SKU-2`, quantities are integers 1–10, destinations are `address-1` or `address-2`.
IDs are bounded identifiers (1–128 characters). There are no generic headers,
credentials, URLs, tool/connector names, commands, module paths, executable
callbacks or provider metadata in this input. The provider client attaches its
own credentials. Transport request IDs and metadata do not affect execution.

```text
protected MCP action -> host admission -> fixed authenticated callable
  -> immutable {contract, action, authority, resourceId, providerArgs}
  -> protectToolCall({operationId, effect: {tool: action, args: preparedEffect}})
  -> existing durable ledger -> provider create -> exact validated receipt
  -> durable CONFIRMED -> MCP response
```

The entire prepared effect determines the existing tool-call fingerprint. The
ledger key is the operationId itself, not an account/tool/payload-derived key.
Same identity and effect replay the retained receipt. A changed argument,
resource, registered action, contract or verified account under that identity
conflicts before dispatch. A genuinely different operationId permits a new
action even with identical payload. The host persists task intent before first
invocation and passes that identity across retries and handoffs. This helper
cannot distinguish a genuine new intent from an agent minting a new ID to evade
uncertainty; the controlled host must enforce that distinction.

## Receipt and reconciliation

Execution success must have exactly these receipt fields:

```json
{
  "providerReference":"order-1",
  "status":"created",
  "operationId":"task-7/order-intent-1",
  "effect":{
    "contract":"once-registered-order-v1",
    "action":"once_create_order",
    "authority":{"provider":"disposable-orders","accountId":"account-A","environment":"local-test"},
    "resourceId":"orders-local",
    "providerArgs":{"sku":"SKU-1","quantity":2,"destinationId":"address-1"}
  }
}
```

The receipt identity and full effect must match. `isError`, provider failure,
malformed or mismatched responses cannot confirm success. Once conservatively
marks callback failure UNKNOWN, even if the provider reports a semantic failure
with zero observed effects.

On an ambiguous retry, only this strict observation can recover confirmation:

```text
{status: "CONFIRMED", authoritative: true, complete: true,
 observedAt: <integer UTC epoch milliseconds>, receipt: <exact matching receipt>}
```

The observation must be no more than 30 seconds old and not future dated. The
provider's read-only lookup must independently supply the persisted receipt;
copying expected arguments into fabricated evidence is not reconciliation.
ABSENT, incomplete, stale, mismatched, malformed, non-authoritative, unavailable
or uncertain observations remain blocked. No negative observation grants a
dispatch right. The existing SDK owns UNKNOWN -> CONFIRMED recovery and durable
replay; this helper adds no reconciliation state machine.

Successful MCP responses have agreeing text and structured content:
`{operationId,status:"CONFIRMED",result}`. Blocked callback outcomes set
`isError:true` and return `{operationId,status,code,retryAllowed:false}`. Schema
validation failures and unregistered tool names are rejected by the MCP server
before the callback. No executed/replayed flag is inferred.

## Durable-state contract and limits

Node 24.15+ is required. The host must provision one persistent same-machine
SQLite ledger using the existing SDK session during deliberate setup, retain its
path and state across processes, and restore that original state after loss.
Registration rejects missing, empty, directory and corrupt storage; it checks
file identity across session initialization. The SDK session detects live path
loss/replacement and keeps WAL/FULL durability. Never automatically provision a
replacement ledger on restart. Host-supplied unrelated valid ledgers, cross-
machine state moves and hostile host/storage tampering are not authenticated by
this local helper. There is no atomic transaction across provider and ledger.

Reads/search/retrieval remain ordinary host tools and need no Once claim. The
fixture advertises only the protected mutation. An independently accessible raw
connector or provider can bypass it: the tests demonstrate a raw duplicate.
Streaming, asynchronous jobs, multi-effect batches, distributed execution,
arbitrary connectors and automatic UNKNOWN retries remain unsupported. No
universal exactly-once claim is made.

## Reproduce

In `mcp/`, with Node 24.15+ and locked dependencies installed:

```text
npm run test:registered-action
npm run test:registered-action-package
npm run smoke
```

The first suite uses actual MCP stdio child processes and an authenticated local
HTTP provider with independently fsynced append-only receipts. The packed suite
installs a local MCP tarball into a clean consumer with published SDK 0.1.25 and
reruns that crossing. It does not publish. `ONCE_TEST_PROOF_PATH` and
`ONCE_TEST_PACKAGE_PROOF_PATH` optionally save effect counts and package evidence.

Tests cover first execution, replay, input/resource/tool/account conflict, new
identity, process concurrency, lost acknowledgement, UNKNOWN and ABSENT blocking,
positive/malformed/stale/mismatched recovery, restart and persisted-intent handoff,
credential/extra-input rejection, admission and authority drift, semantic/MCP
failure, bad receipts, process crash, unavailable/corrupt state and raw bypass.
The crash test advances a persisted abandoned lease by fault injection; it does
not simulate a new execution right. Windows locks open SQLite files, so the
state test injects schema corruption and verifies missing-state restart. Live
path replacement is additionally exercised on platforms that permit the rename.

## Package reality (7 October 2026)

* Published MCP 0.1.5 pins SDK 0.1.14 and lacks this helper.
* This branch pins SDK 0.1.25. Its published root and `connect` exports supply all
  primitives used here; a new SDK release is not needed for this implementation.
* The branch's package version still says 0.1.5. Its locally packed artifact is
  different from published 0.1.5 and must receive a new MCP version before any
  eventual release. Do not overwrite or describe it as the published package.
* The repository OpenAI plugin is version 0.1.1 and launches MCP 0.1.5 helper
  mode. It remains unchanged. An eventual plugin update must pin the new MCP
  version, provision an explicitly approved host capability/ledger/admission
  boundary, and advertise its protected alias. Updating a package pin alone
  cannot register an action or invoke a sibling opaque connector.
* No npm publication, plugin rollout, merge, release, deployment or public
  infrastructure change is part of this work.

A future agent could use this action when the trusted fixture host is explicitly
connected. This test supplies MCP client calls, not a new 6.1 model-run transcript
or an installed ChatGPT plugin end-to-end reproduction. Arbitrary Adobe/GitHub
connector execution remains unsupported.
# Existing-ledger admission repair

Registration now uses a non-mutating admission guard before the SDK session is opened, holding a SQLite startup transaction across that open. It validates the existing operations table, columns, state constraint, basic row validity and SQLite integrity, then verifies file identity and schema version again after opening. Every tool call rechecks admission; a failure permanently invalidates that host session. Missing, empty, corrupt or schema-lost ledgers are not initialized or repaired. The original SDK remains 0.1.25; this guard protects the opt-in MCP boundaries, not every direct SDK caller. Explicit fresh-install provisioning remains separate. Valid-looking row deletion or ledger rollback cannot be detected solely from the remaining SQLite file and is outside this corruption-detection guarantee.

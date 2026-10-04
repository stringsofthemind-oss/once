# Prevent a duplicate refund after acknowledgement loss and process restart

The canonical FIRST 10 proof uses published SDK 0.1.25, Node 24.15+, and built-in Node modules. No account, API key, or money movement.

One-command fixture proof:

```sh
npx --yes --package=@once-agent/sdk@0.1.25 once prove
```

From a checkout:

```sh
npm install --no-save --package-lock=false @once-agent/sdk@0.1.25
node examples/first10/prove.mjs
```

From an empty directory:

```sh
npm install @once-agent/sdk@0.1.25
curl -fsSLo prove.mjs https://onceexec.com/first10/prove.mjs
node prove.mjs
```

PowerShell download: `Invoke-WebRequest https://onceexec.com/first10/prove.mjs -OutFile prove.mjs`.

## What happens

Caller child process → loopback HTTP refund provider → separate flushed effect journal.
Once keeps a separate SQLite file. Each caller stage starts a fresh process. The provider deliberately has no native deduplication and drops its HTTP connection **after** journaling the refund. The parent observes provider truth over HTTP and checks it against the journal at every stage.

1. Without Once: commit, lost acknowledgement, fresh-process blind retry → **2 writes**.
2. Confirmed path: first write, fresh-process replay, changed £50 to £80 → **1 write**, CONFLICT adds **0**.
3. Lost acknowledgement: first write → UNKNOWN; fresh-process retry blocked → **1 write**.
4. Unavailable truth and NOT_FOUND both remain blocked → **1 write**.
5. Read-only reconciliation retrieves `refund_1`; fresh-process replay returns it → **1 write**.

Expected output:

```text
WITHOUT ONCE: acknowledgement lost; fresh-process retry -> 2 provider writes
CONFIRMED: 1 provider write; restart replay; changed £50 -> £80: CONFLICT, 0 additional writes
RETRY BLOCKED — ORIGINAL OUTCOME UNKNOWN
The refund may already have succeeded. Once sent no second request.
LOST-ACK: 1 provider write; restart replay; changed £50 -> £80: CONFLICT, 0 additional writes; UNKNOWN -> CONFIRMED; recovered refund_1
PASS
```

A failing assertion exits nonzero. The printed evidence directory contains journals, SQLite state and `report.json`. Every run uses fresh state; never delete production state to make a proof pass.

## Protect your own operation

Natural Placement wraps a host-owned unary async callback. The developer explicitly chooses identity and effect fields:

```js
import { wrapTool } from "@once-agent/sdk";
const safeRefund = wrapTool(refundCustomer, {
  operationId: x => `${x.tenantId}:refund:${x.refundIntentId}`,
  effect: x => ({ tool: "payments:reviewed-account:refund", args: x }),
  statePath: "./durable/operations.sqlite",
  reconcile: lookupAuthoritativeRefund,
});
```

`refundCustomer` and `lookupAuthoritativeRefund` are your reviewed provider functions, not built-ins. Inspect every argument; include all effect-bearing fields and account/tenant authority. Exclude Authorization credentials. A refund intent is not always the invoice: legitimate partial refunds need distinct intent IDs. Keep identity stable across transport retries. Route all writes through `safeRefund`; opaque retries inside the callback remain outside the boundary.

`lookupAuthoritativeRefund({operationId, effect})` returns `{status: "CONFIRMED", result}` only from authoritative provider truth, otherwise `{status: "UNKNOWN"}`. Omit reconciliation if unsupported: UNKNOWN remains blocked. See [the complete integration guide](../natural-placement/README.md).

## When you do not need Once

Use provider-native idempotency or a database constraint alone when it fully solves the operation. Harmless repeated reads do not need this protection. Retain native idempotency alongside Once where available.

## Limits

This is a controlled provider, not Stripe, an independent user, or production certification. It exercises acknowledgement loss and fresh-process restart, not power loss or every crash point. The fake journal defines authoritative truth only for this fixture. Real providers need reviewed lookup, authority, concurrency and idempotency contracts. Local SQLite covers cooperating callers on one machine only. UNKNOWN can block indefinitely. No untrusted application code is invoked.

## Record a 60–90 second walkthrough

Show the failure scenario; run `node examples/first10/prove.mjs`; pause on UNKNOWN; open the printed `report.json`; end with the wrapper and provider-idempotency boundary. Output completes quickly; narration supplies context. A recording is not included.

Maintainers: build the SDK, then regenerate the standalone assets with `node scripts/generate-first10-proof.mjs`. Validate with `--check`.

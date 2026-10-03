# Once SDK 0.1.24 — Natural Placement

Adds public `wrapTool(callback, semantics)` for host-owned unary tool callbacks. It delegates to `protectToolCall()` and `protectLocal()` using the existing SQLite authority, with no new ledger, schema, or execution state machine.

Synchronous selectors must supply stable application-owned `operationId` and complete `effect: { tool, args }`, including account/tenant/target authority. The callback receives frozen declared `effect.args`. Confirmed JSON-safe receipts replay; changed effects conflict. UNKNOWN never permits redispatch. Recovery still requires authoritative positive read-only reconciliation of the exact effect; absent, malformed, or uncertain truth remains blocked.

Implementation: [PR #283](https://github.com/stringsofthemind-oss/once/pull/283), merge `ff9c5173e82405b870d8974b46b57a9b0b8a527b`. Local demonstrations cover plain callbacks and actual MCP SDK 1.27.1 client/server with linked in-memory transports. MCP SDK is a test-only devDependency; MCP package/version/pins are unchanged.

## Consenting live external-provider verification

On 2026-10-03, an isolated consumer installed the actual tarball packed from merged commit `ff9c5173e82405b870d8974b46b57a9b0b8a527b` (pre-bump manifest 0.1.23). The host-owned callback used GitHub CLI API requests to create exactly two synthetic comments on [dedicated issue #284](https://github.com/stringsofthemind-oss/once/issues/284). Separate paginated provider GETs counted all comments and exact marker matches after every step; no JSON receipt alone was treated as proof of a write.

| Step | Independently observed comments | Host dispatches | Result |
|---|---:|---:|---|
| Baseline | 0 | 0 | Empty dedicated surface |
| First execution | 1 | 1 | Confirmed receipt |
| Identical retry | 1 | 1 | Same receipt |
| Changed-effect retry | 1 | 1 | CONFLICT |
| Fresh-process replay, same SQLite authority | 1 | 1 | Same receipt; child dispatches 0 |
| Separate lost-ack operation | 2 | 2 | Provider success followed by intentional host exception; UNKNOWN |
| UNKNOWN retry | 2 | 2 | UNKNOWN, no redispatch |
| Authoritative read-only reconciliation | 2 | 2 | One exact repo/issue/body/author lookup; CONFIRMED |
| Final replay | 2 | 2 | Reconciled receipt replayed |
| Separate final provider count | 2 | 2 | Exactly one comment per operation |

Provider effects: [normal comment 5968186235](https://github.com/stringsofthemind-oss/once/issues/284#issuecomment-5968186235) and [lost-ack comment 5968186602](https://github.com/stringsofthemind-oss/once/issues/284#issuecomment-5968186602). Marker: `natural-placement-ff9c517-20261003`. A separate GitHub API inspection after the harness independently confirmed these exact two comments. The issue creation is test-surface setup, separate from the two protected callback effects. No production/customer/payment/email resources were used.

This proves the exercised GitHub callback flow on one Windows host and retained SQLite authority. It does not certify every provider or reconstruct real transport failures: acknowledgement loss was deliberately injected after confirmed provider completion. The earlier failed Webhook.site attempt remains unverified.

## Validation and publication gates

Implementation PR: all 22 checks green before merge. Windows Node 24.19.0 full `npm run test:release` exited 0: 198 Node tests passed, 0 failed/skipped, including wrapper 17/17 and tool-call 16/16. Additional local/MCP/Connect/Gateway subset 47/47 and local-session 5/5 passed. Packed ESM/CommonJS/TypeScript consumer checks passed in the release suite. Release-candidate full suite, protected packed Connect/Gateway tests, version/site guards, isolated actual-candidate ESM/CommonJS/types checks, and release PR CI must pass before publication.

Only `@once-agent/sdk` 0.1.24 is to be published. Public npm and GitHub latest were rechecked as 0.1.23, with no 0.1.24 version, before preparation. Existing published website metadata and onboarding pins remain unchanged because they represent published install authority and are outside this SDK release scope.

## Limits

Requires Node 24.15+ for local SQLite and one durable same-machine authority shared across retries/processes. No multi-host guarantee, automatic identity/effect inference, or universal exactly-once claim. Developers own complete semantics, fixed callback authority, normalized completion receipts, and authoritative lookup. Mutable closures, hidden provider defaults, and opaque callback internal retries/writes are outside Once visibility: one callback dispatch can cause multiple effects. Deleted, split, replaced, rolled-back, or stale-restored state cannot preserve prior knowledge. Streaming/non-JSON receipts and model-side connectors without host-callable capability remain unsupported by this wrapper. No new MCP proxy or framework-specific public adapter is introduced.

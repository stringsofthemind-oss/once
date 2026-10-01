# Optimization decision record — 1 October 2026

Owner-authorized branch work; no merge, release or production deployment.

## Product thesis

The smallest paid product is one supported consequential workflow with managed
durable authority, inspectable outcomes and provider-truth recovery assistance.
The free local kernel remains useful. Optimize adoption and trust before breadth.

## Ranked P0/P1 plan

| Rank | Priority | Change | Status / evidence |
|---|---|---|---|
| 1 | P0 | Make current guarantees and deployment boundaries explicit | Implemented: GUARANTEES and production runbook |
| 2 | P0 | Give developers one credential-free first-action entry point | Implemented: existing once prove promoted; canonical source/packed example |
| 3 | P0 | Preserve identity ownership and make UNKNOWN operable | Implemented guidance; no new inspection/recovery service claimed |
| 4 | P1 | Eliminate current-version drift and prevent recurrence | Implemented source-surface guard, drift regressions and registry verification |
| 5 | P1 | Fix platform-specific test defects and gate portability | Implemented fixtures, plugin line-ending checks and CI matrix; non-Windows execution pending |
| 6 | P1 | Align MCP with reviewed SDK and verify the runtime boundary | Implemented 0.1.22 pin/lockfile; smoke and boundary/stdio/replay/persistence checks |
| 7 | P1 | Define one sellable package and measurable pilot acceptance | Implemented internal commercial experiment; price/adoption unvalidated |
| 8 | P0 | Establish deployed hosted production safety and authority continuity | Deferred: requires actual deployed-version evidence, operator decisions and separate owner approval; no speculative redesign |

## Truth audit

| Public claim | Evidence | Status | Confidence / boundary |
|---|---|---|---|
| Current SDK is 0.1.22 | npm metadata; source package; inspected artifact | PROVEN as published-version identity | High; branch additions are unreleased |
| Same ID/effect replays | local/Connect regressions; durable receipt code | SUPPORTED BUT BOUNDED | High on tested same-file local paths |
| Changed effect conflicts | binding and execution regressions | SUPPORTED BUT BOUNDED | Depends on complete trusted selectors |
| UNKNOWN blocks blind local retry | source transitions; lost-ack/crash tests | SUPPORTED BUT BOUNDED | Does not imply eventual completion |
| Local absence permits redispatch | local source explicitly refuses it | FALSE if stated generically | Guide now distinguishes local/adapter models |
| Recovery needs no saved issue number | marker lookup implementation and controlled tests | PARTIALLY PROVEN | Live issue counts owner-reported; mutable trusted repository assumptions |
| Restart preserves protection | retained-file replay and crash tests | SUPPORTED BUT BOUNDED | Ledger deletion/rollback not covered |
| Same-machine multiple processes coordinate | SQLite claim and process tests | SUPPORTED BUT BOUNDED | Same persistent file; no network filesystem |
| Local wrappers coordinate hosts | No shared authority for separate files | FALSE | Explicitly unsupported |
| MCP install protects all calls | discovery/setup separate from runtime | FALSE | Connected proxy/tool path must be configured |
| OpenAI FunctionTool boundary is supported | structural invoke adapter and tests | SUPPORTED BUT BOUNDED | Trusted identity/effect; no certification of every framework version |
| New hosted path is production-ready | readiness document says not deployed | UNVERIFIED | No production changes or live proof performed |
| 60-second first integration | no full human onboarding measurement | UNVERIFIED | Removed from current surfaces |
| Security/compliance/availability guarantees | no deployed-service audit in this work | UNVERIFIED | No new such claims added |
| Hosted retention/billing prevents safety-state deletion | source contract and runtime regressions | SUPPORTED BUT BOUNDED | Deployment/configuration remains separate |
| £200 package has buyers | no paid customer cohort | UNVERIFIED | Internal experiment only |

## Audit coverage

The source inspection covered repository layout and public docs; both SDK
metadata/client/core/storage surfaces; MCP server/proxy and package pins;
CLI/scanner/protect/apply and HTTP/local transformer boundaries; local state,
identity/payload, reconciliation contracts; Connect/Gateway/OpenAI adapters;
monitor/discovery/observation surfaces; examples and regression scripts;
website/static/dynamic versions; CI, package contents and release references;
hosted transport, credentials, metering/retention and production-readiness records.
Tests exercise specific contracts. This is not exhaustive line-by-line review
of every source file or certification of all provider/deployment behavior.

## Limits retained intentionally

No kernel state transition, storage schema or identity algorithm changed.
No model-owned identity, UNKNOWN expiry, unsafe fallback, arbitrary interception
or public service readiness claim was introduced. Authority-loss recovery,
multi-host storage changes and new outcome APIs need separately scoped design.
Historical evidence pins remain frozen; incomplete historical changelog entries
were not fabricated. Existing commands remain compatible while their first-user
presentation is simplified.

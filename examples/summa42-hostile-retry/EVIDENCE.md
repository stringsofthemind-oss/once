# Once / Summa42 #35 evidence report

Prepared 20 October 2026. Target: [SofiaFlux/summa42 #35](https://github.com/SofiaFlux/summa42/issues/35), fetched with all comments (none) on this date. This is a Once-side conformance demonstration, not an implementation or test run inside Summa42. No third-party independent evaluator has reviewed it.

## Finding and claim boundary

With the same canonical operation identity, complete effect binding, original durable ledger and reviewed host-owned action, Once suppresses a second provider write after commit, acknowledgement loss, abrupt worker termination and replacement attempts. It conservatively blocks unresolved outcomes, then recovers the exact receipt through authoritative read-only provider lookup and persists replay.

The package **does not satisfy the whole of #35 by itself**. Once does not prevent a planner from inventing a new logical ID, does not gate unrelated planner progress, and the tested local registered action cannot recognize a schema-valid replacement ledger across separate process lifetimes. Those controls belong to the host / shared execution authority and need a Summa42 integration. No universal exactly-once guarantee is claimed.

## Audit and reuse

Base source: `8381734` (full revision in `provenance.json`), fetched from Once `origin/main`. Source SDK reports 0.1.26, while `docs/published-versions.json` identifies SDK 0.1.25 and MCP 0.2.1 as public versions. The standalone package bundles local builds of SDK 0.1.26 and MCP 0.2.1; it explicitly overrides MCP's declared SDK 0.1.25 dependency. These are exact local build qualifications, not proof of registry publication. A separate published-SDK consumer and existing packed-consumer regression are identified in validation records.

Reused infrastructure:

| Existing component | Audit finding / reuse |
| --- | --- |
| `sdk/typescript/src/local.ts` | Atomic SQLite claim; durable `CLAIMED`, `UNKNOWN`, `CONFIRMED`; live lease is `IN_FLIGHT`; expired claim becomes UNKNOWN; no redispatch even on ABSENT; complete payload fingerprint conflict; durable replay. The low-level opener creates missing state and is not a state-continuity guard. |
| `sdk/typescript/src/tool-call.ts` | Explicit developer-supplied operation ID; frozen complete effect; transport metadata excluded; strict reconciliation envelope. It trusts the host's provider-truth adapter. |
| `mcp/src/registered-action.ts` | Existing narrow local-test order action; host-owned provider/account/resource/tool binding; strict input, admission and receipt schemas; fresh complete authoritative evidence must match operation ID and full prepared effect. No generic connector execution. |
| `mcp/src/existing-ledger.ts` | Existing-only startup admission and schema checks; fail closed for missing/empty/corrupt state and schema loss; live file identity checking. It does not pin an independently stored ledger identity across host restarts. |
| `mcp/test/registered-action.test.mjs` | Existing actual MCP/process/provider coverage, drift, bad truth, authority drift, malicious inputs, state loss and crash. Existing crash test expires a lease by editing SQLite. All assertions preserved. |
| `mcp/test/fixtures/order-provider.mjs` | Stateful loopback twin, every accepted POST fsyncs an independent receipt, no idempotency key enforcement or deduplication. Existing `hold` and `lost-ack` modes retained. Added commit/drop observer hooks and explicit lookup socket failure injection. |
| `mcp/test/fixtures/order-host.mjs` | Existing stdio host and production registration reused. Added optional test-only barrier after actual socket acknowledgement loss, before returning to Once. Parent kills the process at this barrier. Ordinary fixture behavior is unchanged. |
| `examples/first10/prove.mjs`, SDK tool-call/local/wrap/MCP-boundary tests | Audited existing proof/API coverage; used existing suites and packed/published consumer checks, rather than creating another execution state machine. |
| `sdk/typescript/src/connect/mcp-execution-boundary.ts` | Audited transport IDs excluded from logical identity and locally reviewed identity/effect selectors. This alternate boundary is covered by existing regressions; the new canonical proof uses the narrower registered action. |

No production SDK or MCP execution semantics were changed. New work is a focused test driver, independent evidence checker, packaging instructions and optional fixture instrumentation.

## Canonical scenario and observable evidence

T02 durably saves `task-35:order:1` and the complete order before dispatch. A child host executes one HTTP POST. The provider appends and fsyncs its receipt, destroys the socket, and the worker observes the failed acknowledgement at a test barrier. The parent checks the separate provider journal and SQLite `CLAIMED` row, kills the worker with `SIGKILL`, waits for the closed call, and launches replacement hosts.

Replacement Attempt 2 has a new process, client name, session label and actual JSON-RPC request ID; it reuses the saved operation ID and ledger. The live lease returns `IN_FLIGHT`. The test waits for the real 30-second lease deadline without changing SQLite timestamps or state. Three unresolved calls and a further process/replanning handoff remain `UNKNOWN` with `retryAllowed:false` and **one POST / one provider effect**.

The test then compares a read-only provider GET against the separately read fsynced journal. The registered reconciliation adapter validates the exact receipt; bounded re-observation permits only UNKNOWN or final CONFIRMED, never another write. A further fresh host replays the confirmed receipt without lookup or dispatch. Events record the order, process IDs, distinct attempt/session IDs, actual request IDs, outcomes and final ledger row.

Attempt/session UUIDs are harness labels, not Summa42 domain objects. Replanning is simulated by a fresh caller loading the saved intent. The provider runs outside the worker in the test driver, owns a distinct journal and never reads the Once ledger; it is an independently observable local twin, not a real commercial provider or independent organization.

## Acceptance mapping

The AC labels below are local report identifiers, in the order of #35's five acceptance bullets.

| Criterion | Test / evidence | Demonstration and limit |
| --- | --- | --- |
| AC1: stateful twin simulates remote effects and dropped/delayed acknowledgements | T01, T02; `provider.jsonl`, commit/drop events; existing registered-action `hold` tests | Stateful non-deduplicating twin, durable commit and explicit dropped socket; raw repeat creates two effects. Existing regressions exercise delayed acknowledgement. The canonical new test covers dropped acknowledgement, not arbitrary network behavior. |
| AC2: OUTCOME_UNKNOWN grants no retry permission | T02, T03, T04, T05 | Actual Once `UNKNOWN` / `retryAllowed:false`, no added write. IN_FLIGHT is also blocked. Once's error name is UNKNOWN; this report does not rename Summa42's state machine. |
| AC3: require external reconciliation before replacement Attempt or planner iteration proceeds | T02, T04, T08; negative limits T06/T07 | **Partial:** the same protected operation cannot redispatch while unresolved; positive lookup recovers its receipt. Replacement hosts can start to read/block/reconcile. Global scheduler/planner progress, unrelated operations, new-ID admission and cross-restart ledger continuity are not implemented here. |
| AC4: non-idempotent dispatch, ack loss, worker kill, replacement, count exactly one unresolved | T02; ordered events, journal, counters, claim/final ledger snapshots | Direct canonical sequence with actual child kill and real lease expiration; exactly one provider POST and one effect. T01 proves the twin itself does not suppress duplicates. |
| AC5: logical effect persists through restart/replanning | T02, T03, T06, T07, T08 | Saved canonical ID, effect fingerprint and original SQLite persist across several fresh hosts; complete effect drift conflicts, confirmation replays. Requires trusted host identity/ledger preservation. Planner-generated replacement IDs and valid replacement ledgers are observed counterexamples. |

## Scenario matrix

| Test | Expected result | Independent final effects / POSTs |
| --- | --- | --- |
| T01 | Raw lost-ack duplicate control | 2 / 2 |
| T02 | CLAIMED -> IN_FLIGHT -> UNKNOWN -> exact CONFIRMED -> fresh-host replay | 1 / 1 |
| T03 | Changed SKU, quantity, destination, tool, resource or verified account: CONFLICT | 1 / 1 |
| T04 | Socket-failed lookup, UNKNOWN, NOT_FOUND, ABSENT, malformed, stale, future, incomplete, non-authoritative or mismatched truth: UNKNOWN; unavailable provider rejects host admission | 1 / 1 |
| T05 | Missing/corrupt/empty ledger rejects startup; live and restarted schema loss is STATE_UNAVAILABLE / startup rejection; missing schema never recreated | 1 / 1 |
| T06 | Input identity injection rejected; original UNKNOWN blocks; arbitrary fresh ID with identical payload is accepted | **2 / 2: demonstrated limit** |
| T07 | Original ledger removed, explicitly provisioned valid empty ledger admitted after restart | **2 / 2: demonstrated limit** |
| T08 | Confirmed effect survives replacement; no GET or POST on exact replay; changed quantity conflicts | 1 / 1 |

## Validation and failure history

Final run paths, versions, commands and exit codes are in `validation.json` and the delivered run directories. Eight named scenario tests plus the enclosing Node test produce nine Node test passes. Expected limit tests are marked PASS because they assert the counterexample; they are not protection claims.

Existing assertions: 71 SDK tests and 25 MCP tests passed on the source-built SDK combination. SDK ESM/CommonJS and MCP builds passed. FIRST 10 generation check and site surface guard passed. Packed SDK and clean published-consumer results are separately recorded; publication and whole-repository test coverage are not implied.

Retained development failures:

- Initial sandboxed execution could not reach loopback: all eight scenarios failed before useful provider execution. Raw control detected zero effects rather than treating a failed network call as success. Re-run with local loopback/process permission.
- The first loopback-enabled run passed seven scenarios but T02 returned conservative UNKNOWN where the test required immediate CONFIRMED on the first positive lookup. It still produced exactly one effect and one POST. The precise transient cause was not established. A subsequent run passed after adding an explicit independent GET/journal comparison. The final test allows at most five read-only reconciliation observations and records all outcomes, always preserving the same identity and never redispatching; it fails unless the exact receipt becomes CONFIRMED. This bounds the claim to observed recovery, not guaranteed first-observation availability.
- Initial dependency installs failed because network access/cache entries were unavailable; authorized network installation of locked dependencies resolved setup. No production credentials were used.

Failed runs are retained as diagnostics, not counted as successful evidence. Read their `results.json`, TAP and events alongside the final run. No existing test was removed or weakened.

## Unsupported / unimplemented guarantees

- Summa42 scheduler, replanner, Attempt model, budget/exposure containment and integration are unimplemented in this package.
- The host must durably select/admit canonical IDs. A fresh arbitrary ID can create a duplicate real-world intent, and the current narrow registered action does not cross-check it against an external intent registry.
- A schema-valid empty ledger can be substituted between process lifetimes. Missing/corrupt/schema-lost state is rejected by the registered action, but this is not a cross-restart continuity witness. The low-level SDK alone also initializes missing state; do not generalize the registered action's guard to all SDK calls.
- Single-machine persistent SQLite only. No distributed execution, split-brain, filesystem rollback, malicious operator, storage hardware power-loss, or provider crash/restart guarantee is established.
- The host owns complete effect binding, authoritative provider lookup, admission and write routing. Hidden provider-client retries, raw bypass and incomplete adapters remain outside the demonstrated boundary.
- No liveness guarantee when truth is absent or unavailable. UNKNOWN remains blocked indefinitely. No real payment, commercial provider, Summa42 deployment, external adoption, independent security audit or universal exactly-once evidence is claimed.

No merge, release, publication, deployment, PR or external comment was performed.

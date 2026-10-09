# ADK completed-sibling replay regression

This isolated lab reproduces [Google ADK #7428](https://github.com/google/adk-python/issues/7428) and compares the exact base and proposed head of [PR #7429](https://github.com/google/adk-python/pull/7429). A successful ticket tool finishes before its parallel pager sibling raises. On affected ADK, the completed tool's response disappears from session history and the next model request.

The provider is a disposable loopback HTTP service. Every write commits a new row to its own SQLite journal; it has **no native deduplication**. The verifier counts those rows independently of Once receipts. Runtime uses no real model or remote provider, and needs no credentials.

## Observed comparison

| ADK code | Completed result saved | History-based retry: raw / Once effects | Forced retry: raw / Once effects |
| --- | --- | --- | --- |
| Released `google-adk==2.11.0` | no | 2 / 1 | 2 / 1 |
| PR base `c220fca16a7e7f7620bde799c50b240f2451ef79` | no | 2 / 1 | 2 / 1 |
| Proposed fix `3e309d5d3eb753343590e28baf5b8efc547645c8` | yes | 1 / 1 | 2 / 1 |

The PR base comparison isolates the proposed fix from other changes since the release. The original pager error propagates unchanged in every version. The failed pager gets no invented response. The scripted model repeats the write if history contains no successful result; a separate adversarial mode forces repetition even when the fixed ADK retains it. This does not reproduce the contributor's live-model 10/10 measurement.

## Protection contract and assertions

The host captures `host-ticket-intent-001` outside model output. ADK call IDs change between attempts; they are transport metadata, never logical identity. Tenant/tool identity, project and title are all effect-bearing fields. Every protected call starts a fresh Node process using the same durable Once file, so a cached in-memory receipt cannot satisfy replay.

Seven real ADK runner scenarios assert history, next-model-request contents, exact receipt replay and independent effect counts: raw/protected history-based retry; raw/protected forced retry; changed-title `CONFLICT`; lost-acknowledgement `UNKNOWN`; and crash-after-commit `UNKNOWN`. The crash host reports uncertainty rather than pretending the missing boundary response is success.

Three additional boundary cases (confirmed, lost acknowledgement, hard crash) each verify title, project and tenant conflicts before dispatch; missing identity rejection; and expected-but-missing ledger rejection. The ambiguous cases remain `UNKNOWN` after unavailable truth or `NOT_FOUND`; neither permits redispatch. An authoritative loopback lookup requires exactly one row matching the original identity **and complete effect**, then confirms and durably replays the receipt. All cases retain exactly one provider effect.

An event handshake orders tool completion before sibling failure; there is no sleep-based scheduling. The test-only claim lease is 1 ms so an abandoned claim is expired by the fresh-process recovery attempt. It is not a production lease recommendation. The host remembers that an existing ledger is expected and checks its presence before SDK initialization; this fixture is not a general host provisioning implementation.

## Run

Requirements: Node 24.19.0 and Python 3.12. Create an isolated Python environment first. From the repository root:

```sh
npm ci --prefix sdk/typescript
npm run build --prefix sdk/typescript
python -m pip install -r examples/adk-parallel-replay/requirements.lock.txt
python examples/adk-parallel-replay/verify.py --output release.json
```

For the source comparison, clone Google ADK separately and create two detached worktrees:

```sh
git clone https://github.com/google/adk-python.git upstream-adk
git -C upstream-adk fetch origin pull/7429/head
git -C upstream-adk worktree add ../adk-base c220fca16a7e7f7620bde799c50b240f2451ef79
git -C upstream-adk worktree add ../adk-fixed 3e309d5d3eb753343590e28baf5b8efc547645c8
python examples/adk-parallel-replay/verify.py --adk-src adk-base/src --label pr-base --output base.json
python examples/adk-parallel-replay/verify.py --adk-src adk-fixed/src --expect-kept --label pr-fixed --output fixed.json
```

`--sdk-url file:///absolute/path/to/node_modules/@once-agent/sdk/dist/index.js` tests a clean packed or published consumer. The checked evidence records both against released ADK, using SDK 0.1.25. Default execution uses the repository SDK build. The separate workflow repeats the release/base/fix matrix and uploads generated evidence. Its remote result must be checked separately from local results.

## Validation recorded on 9 October 2026

All five local fixture runs passed: release, exact PR base, exact PR head, clean packed Once consumer and clean registry consumer. Each runs seven ADK scenarios plus three boundary cases (35 ADK scenarios and 15 boundary cases total). `evidence.json` contains their model/session observations, receipts and independently counted provider rows. Recorded platform: Windows, Python 3.12.10, Node 24.19.0.

The focused upstream tests are taken from the proposed head in both comparisons:

```sh
PYTHONPATH=adk-fixed/src python -m pytest adk-fixed/tests/unittests/test_runners.py adk-fixed/tests/unittests/flows/llm_flows/tools/test_batch_executor.py -k 'tool_error or keep_completed or plain_result' -q
# Repeat with PYTHONPATH=adk-base/src, keeping the same head test files.
```

The head passed 16 tests; the base failed 14 and passed the two regression guards (200 deselected). Optional upstream-test dependencies are separate from the fixture lock: `a2a-sdk[http-server]==1.2.2`, `pytest-mock==3.16.0`, `google-api-core==2.28.1`, and `opentelemetry-api==1.42.1`. The full upstream suite was not run.

Repository checks passed: SDK build; `node --test test/tool-call.test.mjs test/local.test.mjs test/wrap-tool.test.mjs test/wrap-tool-mcp.test.mjs test/first10.test.mjs` from `sdk/typescript` (58 tests); `npm run test:first10-package`; `npm run test:wrap-tool-package` (14 ESM/CJS checks plus TypeScript contracts); `node scripts/generate-first10-proof.mjs --check`; `node scripts/check-site-surface.mjs`; and `node scripts/generate-site-surface.mjs --check` from the root. No proof asset drift required regeneration. Initial restricted-network fixture execution and direct invocation of package scripts did not pass; the recorded passes use loopback access and the required npm entry points.

## Limits

This is deterministic same-machine integration evidence with independently counted **fixture** effects. ADK session history is in memory; Once state and provider effects are durable SQLite. The Once boundary restarts, but this does not qualify whole-framework crash recovery, distributed authority, live mode, confirmation/control-flow results, cancellation races, opaque provider retries, real-model decisions or production providers. It changes no protection kernel or public API. It demonstrates neither universal exactly-once execution nor independent production qualification, adoption or endorsement by Google.

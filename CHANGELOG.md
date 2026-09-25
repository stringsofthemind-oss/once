# Changelog

All notable changes to the Once SDK are documented here.

## 0.1.12 - 2026-09-25

### Added

- Automatic Connect tool classification with `PROTECT`, `BYPASS`, and fail-closed `UNKNOWN` decisions.
- Whole-manifest protection planning for native/MCP-style and OpenAI-style function tools.
- Automatic logical-operation identity resolution from trusted intent/idempotency carriers and explicit Once metadata.
- Conservative automatic effect-payload binding with explicit `effectFields` support.
- Whole-registry fail-closed local tool wiring through `connectLocalAgentToolsetAuto`.
- Structural OpenAI Agents FunctionTool integration through `connectOpenAIAgentsFunctionToolsAuto` without making `@openai/agents` a runtime dependency.
- Public `@once-agent/sdk/connect` ESM, CommonJS, and TypeScript subpath exports.
- Phase 11A universal tool discovery through read-only `once doctor . --tools`, including major MCP host/config discovery, source/framework tool discovery, canonical Tool Graph records, effect categories, `I0–I5` criticality, and action-priority ranking.
- Phase 11B explicit authoritative MCP enumeration with `--tools-live=<host/name>`, modern 2026-07-28 `server/discover` negotiation, legacy `initialize` fallback, bounded `tools/list` pagination, schemas, annotation hints, and `SERVER_AUTHORITATIVE` evidence.
- Bounded modern MCP tool-list refresh with `--tools-watch-ms=<ms>` using `subscriptions/listen`; a `tools/list_changed` notification triggers an authoritative re-list and namespaced added/removed/changed diff before the command exits.
- Stable `host/server/tool` refresh namespaces and deterministic PROJECT-before-USER configured-source precedence.
- Phase 11C runtime/model visibility discovery with distinct `RUNTIME_REGISTERED` and `MODEL_VISIBLE` Tool Graph evidence.
- Public `@once-agent/sdk/discovery` ESM, CommonJS, and TypeScript subpath for dependency-free structural runtime observation.
- Phase 11C priority framework adapters for OpenAI Agents/Responses, Vercel AI SDK, LangChain/LangGraph, Pydantic AI, Google ADK/Gemini, Strands Agents, and Microsoft Semantic Kernel.
- Framework adapters preserve same-named tools as distinct observations when their safe descriptions, schemas, or metadata differ instead of collapsing them by name alone.
- Phase 11D execution observation with `EXECUTED` Tool Graph evidence, observed call counters/outcomes/timing, and action-priority recomputation after real execution evidence.
- Observation-only execution adapters for OpenAI Agents lifecycle events, Vercel AI SDK completed-step results, LangChain/LangGraph tool callbacks, and OpenTelemetry GenAI `execute_tool` spans.
- Phase 11E selective Gateway routing through the public `@once-agent/sdk/gateway` ESM/CommonJS/TypeScript subpath, with deterministic `DIRECT`, `PROTECT`, and fail-closed `BLOCK` routes for the runtime-selected tool subset.
- Phase 11E local Gateway broker through `connectLocalGatewayToolsetAuto`, delegating protected execution to the existing Connect/`protectLocal` engine rather than introducing a second execution engine.
- Exact Tool Graph-to-Gateway binding by canonical tool name plus descriptor fingerprint, preserving strong discovery/execution evidence for reporting without allowing that evidence to downgrade a planned protection route.
- Structural OpenAI Agents FunctionTool Gateway integration through `connectOpenAIAgentsFunctionToolsGatewayAuto` without adding a hard `@openai/agents` dependency or expanding the supplied model-visible tool subset.

### Safety and validation

- Added a 125-case classifier corpus guarding against unsafe silent bypasses and ambiguous tool semantics.
- Added exact manifest-to-registry matching so duplicate, missing, undeclared, invalid, or `UNKNOWN` tools block connection.
- Automatic routing continues to fail closed when identity or effect semantics cannot be established safely.
- Added packed-tarball regression coverage for the `@once-agent/sdk/connect` ESM/CommonJS/type contract.
- Added packed Node.js 24.15 local-protection regression proving first execution, confirmed replay without a second effect, changed-payload conflict blocking, and durable SQLite state from an installed package artifact.
- Plain `once doctor . --tools` remains offline; live MCP contact requires an explicit configured server selector.
- Phase 11 live discovery never launches configured stdio server commands, never follows redirects, enforces timeout/response/page/tool bounds, and does not retain configured secret header values in discovery results.
- Tool enumeration and refresh never invoke MCP tools or automatically apply Once protection; the release-gated regressions explicitly prove no `tools/call` occurs.
- Modern tool watching is bounded and foreground-only; no background daemon is created. Legacy 2025-era servers remain supported for authoritative enumeration, while the bounded watch command targets the 2026-07-28 `subscriptions/listen` model.
- Phase 11C framework adapters observe already-existing registration/model-request state only: they do not invoke tools, run agents/graphs, call models/providers, resolve external toolsets, evaluate framework execution filters, or treat framework hints as a security boundary.
- Runtime discovery keeps getter-backed or non-plain framework internals inert/opaque, redacts secret-like schema and metadata values, and counts unresolved runtime sources instead of guessing.
- The packaged `@once-agent/sdk/discovery` contract is release-gated through clean-tarball TypeScript, ESM, and CommonJS consumers.
- Phase 11D observers do not wrap or invoke tools to learn that they ran, and do not retain tool arguments/results, prompts, exception text, auth, provider/model metadata, callbacks, or arbitrary runtime objects.
- Execution promotion requires exact Tool Graph correlation plus a safe descriptor fingerprint; duplicate or ambiguous name-only telemetry fails closed rather than promoting the wrong tool.
- Phase 11D is release-gated by an end-to-end `RUNTIME_REGISTERED -> MODEL_VISIBLE -> EXECUTED` evidence ladder and a fresh packed-tarball ESM/CommonJS/TypeScript execution-observation consumer.
- Phase 11E never converts `BLOCK` into direct execution, never injects the global Tool Graph into model context, and refuses partial wiring when any selected tool remains unresolved.
- Phase 11E Tool Graph binding fails closed on missing, stale, fingerprint-mismatched, or ambiguous records; Tool Graph evidence can increase urgency/confidence but cannot weaken `PROTECT`.
- Phase 11E OpenAI Gateway proof keeps transport/tool-call IDs separate from logical Once operation identity; retries with different transport IDs but the same trusted intent replay one confirmed protected effect.
- Phase 11E is release-gated by a fresh packed Node.js 24.15 customer-artifact regression proving mixed `DIRECT`/`PROTECT` routing, one protected effect across retries, changed-payload conflict blocking, exact Tool Graph binding, OpenAI structural integration, and durable local SQLite state.
- CrewAI, LlamaIndex, and Agno runtime adapters are explicitly deferred to the later discovery backlog rather than blocking Phase 11D execution observation.
- No universal exactly-once claim is made; local automatic protection remains same-machine SQLite coordination and ambiguous outcomes still require authoritative reconciliation where applicable.

## 0.1.11 - 2026-09-25

### Added

- Registered agent-tool connection for the local Once protection boundary.
- Agents can call the connected tool normally while retries reuse confirmed outcomes.

### Safety

- Changed effect-bearing payloads conflict rather than silently re-execute.
- Uncertain outcomes require provider truth before safe redispatch.
- Local connected-tool protection requires Node.js 24.15+ and shared durable SQLite state on one machine.

## 0.1.10 - 2026-09-25

### Changed

- `once protect` now explains safe next steps for adapter-required operations, distinguishing a controlled local proof from a real provider integration.
- Automatic rewriting remains unavailable for adapter-required callsites.

## 0.1.9 - 2026-09-25

### Changed

- `once doctor` now prints runnable, package-qualified follow-up commands when used in a fresh project.
- This release improved the CLI adoption flow without changing the execution-safety model.

## 0.1.8 - 2026-09-25

### Added

- `once doctor [directory]` as a local, read-only adoption front door.
- Default Doctor assessment requires no `ONCE_API_KEY`, uploads no source code, and does not modify application source.
- Doctor reports detected project tooling and likely consequential-operation candidates.
- `once doctor . --protect` generates a review plan and per-callsite integration snippets without rewriting source.
- `once doctor . --connection` explicitly verifies hosted Once connectivity.
- Doctor adoption regression coverage is included in the SDK release suite.

### Runtime requirements

- General SDK: Node.js 18+.
- `protectLocal`: Node.js 24.15+.

## 0.1.7 - 2026-09-24

### Added

- `protectLocal` same-machine execution protection with SQLite-backed durable state.
- Confirmed retries can replay/suppress duplicate execution for the same logical action and effect-bearing payload.
- Local protection can be used without a Once API key or provider registration.
- `prepack` build step so clean npm packaging includes `dist/` and `dist-cjs/` reliably.

### Safety

- Reusing a logical action ID with changed effect-bearing payload is rejected as a conflict.
- Ambiguous outcomes fail closed rather than blindly redispatching.
- `protectLocal` requires Node.js 24.15+; the general SDK remains compatible with Node.js 18+.

> Note: no GitHub SDK release tagged `v0.1.6` was published.

## 0.1.5 - 2026-09-20

### Added

- First narrow Runtime HTTP execution-safety path for consequential agent and application writes.
- Runtime fetch interception with `PASS`, `PROTECT`, and `BLOCK` decisions.
- Stable operation identity with fail-closed handling when identity is missing or conflicting.
- Replay-capable setup using `response_replay=required`.
- Durable sanitized HTTP response replay through Once Cloud.

### Safety and validation

- Unsupported protected write shapes fail closed rather than falling back to the target.
- Protected Runtime execution is intentionally narrow and does not claim generic exactly-once execution.
- In the tested live Cloudflare staging scenario, two identical Runtime attempts produced one provider execution and one synthetic external effect while the retry returned the same durable sanitized HTTP response.

## 0.1.4 - 2026-09-19

Metadata-only patch release.

### Changed

- Added the verified public GitHub repository URL to npm package metadata.
- Added the public project homepage.
- Added the GitHub issues URL for package support and bug reports.
- No SDK execution logic changed in this release.

## 0.1.3 - 2026-09-19

Documentation-only patch release.

### Fixed

- Replaced the unreliable one-shot Windows npm execution instructions with the verified public install flow.
- Install with: `npm install @once-agent/sdk`.
- Then run: `npx once setup .`.
- Verified `npx once --help` after a clean public npm install.
- Verified `npx once setup . --plan` after a clean public npm install.

No SDK execution logic changed in this release.

## 0.1.2 - 2026-09-19

Hardened release following the previously published 0.1.1 package.

### Added

- Interactive CLI activation through the Once sandbox customer flow.
- Permanent activation-flow regression coverage.
- Exact target-URL authorization through provider `allowed_urls`.
- Permanent Customer Zero duplicate-prevention regression coverage.

### Changed

- Added ESM and CommonJS package compatibility.
- Excluded `.once` generated artifacts from source scanning.
- Improved missing-configuration diagnostics for `protect --apply`.
- Strengthened provider outcome reconciliation.
- Public CLI examples explicitly target `@once-agent/sdk` to avoid the unrelated `once` npm package.

### Safety

- Deterministic provider HTTP failures do not imply that no side effect occurred.
- `FAILED_BEFORE_EFFECT` requires explicit provider proof of no execution.
- Ambiguous credential issuance is not automatically retried.
- Automatic transformation fails closed when the target URL is not explicitly authorized.
- Once continues to make no universal exactly-once claim.

### Validation

The 0.1.2 release candidate passed the complete core and SDK release suites, package-consumer tests, activation regression, packaged-artifact regression, Customer Zero duplicate regression, and live deployment checks.

## 0.1.1 - 2026-09-19

Release-candidate baseline for the Once TypeScript SDK and CLI.

### Added

- `once setup` onboarding flow.
- `once scan` local consequential-operation discovery.
- `once protect` protection review workflow.
- `once protect --apply` conservative automatic transformation.
- `once doctor` connection verification.
- TypeScript SDK with ESM and CommonJS package support.
- Stable operation-ID helpers.
- Provider registration and capability handling.
- Provider-truth reconciliation for supported integrations.
- Durable operation-state handling.
- Sandbox Stripe test activation flow.
- CLI API-key acquisition and `.env` persistence.
- Permanent duplicate-prevention regression coverage.
- Package-consumer and packaging regression tests.

### Safety

- Once does not claim universal exactly-once execution.
- Automatic source transformation fails closed when a callsite is not fully supported.
- Ambiguous provider outcomes remain uncertain unless authoritative provider truth proves otherwise.
- Retries must reuse the same stable operation ID for the same real-world action.

### Release validation

The 0.1.1 release-candidate baseline passed:

- core release suite;
- SDK release suite;
- clean package-consumer tests;
- npm package dry run;
- Customer Zero duplicate-prevention regression;
- live sandbox contract checks;
- production core status checks.

# Phase 11E — Once Gateway / broker

Status: design for implementation on repository `main`. This document does not change runtime behaviour.

## Purpose

Phase 11E turns the Phase 11 Tool Graph and Once Connect into a selective execution gateway without turning Once into a general agent orchestrator.

The gateway exists for one reason:

> A model or agent has already selected a tool. Before that tool produces a consequential external effect, Once decides whether the invocation may run directly, must use the existing protection path, or must stop because safety cannot be established.

The gateway must not force the entire Tool Graph into model context. Discovery is the control plane; execution routing is the data plane.

## Non-goals

The Phase 11E gateway is not:

- a general workflow/orchestration engine;
- a replacement model/tool registry;
- a prompt-time catalog dump;
- an authorization system;
- a policy engine that grants permission to perform dangerous actions;
- a second Once execution engine;
- a hidden network proxy that contacts arbitrary tool servers;
- a universal distributed exactly-once implementation.

## Core routing model

For an exact tool invocation, the gateway produces one of three routes:

- `DIRECT` — Once has sufficient evidence that duplicate-effect protection is not applicable. Execution delegates to the original tool implementation unchanged.
- `PROTECT` — the tool is consequential under the existing Once Connect classifier. Execution delegates to the existing Connect/protect path.
- `BLOCK` — safety, identity, payload, descriptor identity, or implementation mapping is unresolved or conflicting. The tool is not invoked.

`BLOCK` is not a fourth execution mode. It is absence of permission to route.

There is no automatic `BLOCK -> DIRECT` fallback.

## Relationship to existing components

Phase 11E must compose existing primitives rather than replace them:

1. Phase 11A–11D Tool Graph and evidence establish what the tool is and how strongly Once knows it.
2. `classifyConnectTool()` remains authoritative for `PROTECT | BYPASS | UNKNOWN` tool-safety classification.
3. Gateway maps:
   - Connect `BYPASS` -> Gateway `DIRECT`
   - Connect `PROTECT` -> Gateway `PROTECT`
   - Connect `UNKNOWN` -> Gateway `BLOCK`
4. Protected execution delegates to `connectLocalAgentToolAuto()` / the existing Once protection engine.
5. Direct execution delegates to the original implementation.
6. Execution observation remains Phase 11D; gateway routing must not manufacture stronger `EXECUTED` evidence merely because it planned a route.

The gateway must never create an alternate implementation of replay, durable state, reconciliation, logical operation identity, or effect-payload binding.

## Control plane vs data plane

### Control plane

The Tool Graph may contain thousands of discovered tools from configs, registries, MCP servers, frameworks, source, and runtime evidence.

The control plane may use that inventory to:

- identify the exact tool descriptor;
- retain evidence level and source;
- rank action priority;
- show protection gaps;
- prepare a deterministic gateway route plan.

Control-plane information does not grant execution authority.

### Data plane

The data plane operates only on a tool invocation that the surrounding runtime has already selected.

It receives:

- exact tool identity / descriptor;
- the matching executable implementation;
- actual invocation input;
- optional Once identity/payload/reconcile overrides.

It then routes only that invocation.

The complete Tool Graph is never automatically appended to the model request.

## Descriptor and implementation identity

Gateway wiring must fail closed unless the executable implementation can be mapped to exactly one descriptor.

For v1 local toolsets:

- tool names must be stable and registry-safe;
- duplicate manifest names are rejected;
- undeclared executable registry entries are rejected;
- missing implementations are rejected;
- the gateway plan preserves a deterministic safe-descriptor fingerprint;
- where a Tool Graph observation is supplied, its identity/fingerprint must agree with the descriptor used to route execution.

A bare display name is not sufficient identity.

## Evidence use

Evidence strength may increase confidence and action priority, but it must never weaken a safety route.

Examples:

- `EXECUTED` evidence can make a consequential unprotected tool more urgent; it cannot turn `PROTECT` into `DIRECT`.
- `MODEL_VISIBLE` can prove exposure; it cannot authorize invocation.
- `SERVER_AUTHORITATIVE` can prove a tool exists; it cannot prove it is harmless.
- stale or conflicting Tool Graph identity causes `BLOCK`, not best-effort routing.

## V1 local gateway API shape

The first implementation should be intentionally small.

### Planning

A pure function should accept the same supported tool-manifest shapes as Connect and return a frozen gateway plan with ordered entries and partitions:

- `direct`
- `protect`
- `blocked`

Each entry should contain only safe routing metadata such as:

- index
- name
- descriptor fingerprint
- route
- reason
- source classification decision

Planning must not execute tools, resolve runtime identities, open SQLite, contact providers, contact MCP servers, or mutate the supplied manifest.

### Wiring

A local gateway wiring function should accept:

- a complete named local registry;
- the gateway/Connect-compatible manifest;
- optional shared `statePath`;
- optional per-tool identity/payload/reconcile overrides.

It should return:

- the frozen gateway plan;
- a frozen registry containing exactly the declared tools.

For each tool:

- `DIRECT` wrapper calls the original implementation with original `this`/input semantics;
- `PROTECT` wrapper is created by the existing `connectLocalAgentToolAuto()` path;
- `BLOCK` prevents whole-set automatic wiring in v1.

Whole-set preflight is deliberate. Returning a partially wired registry would leave a silent bypass surface.

## Why v1 blocks a toolset containing UNKNOWN

A future broker may support invocation-time selective lookup from a much larger Tool Graph. The first local gateway should not attempt this until identity and catalog semantics are proven.

For v1, if a runtime chooses to expose a declared toolset through the gateway, every executable entry in that exposed subset must have a deterministic route before wrappers are returned.

This does **not** mean every tool in the global Tool Graph must be classified. Only the toolset/subset being exposed by that runtime must be route-ready.

This is the key model-context property:

> The gateway protects the runtime's selected tool subset; it does not copy the global discovery catalog into the model-visible subset.

## Failure semantics

The gateway must fail closed before an external effect when any required protection fact cannot be proven.

Examples:

- unknown tool semantics -> `BLOCK`;
- descriptor/Tool Graph mismatch -> `BLOCK`;
- protected tool missing stable logical-operation identity -> existing `IDENTITY_REQUIRED` failure;
- conflicting identity carriers -> existing `IDENTITY_CONFLICT` failure;
- protected tool missing effect payload -> existing `PAYLOAD_REQUIRED` failure;
- payload drift under the same logical operation identity -> existing conflict behaviour;
- ambiguous provider outcome -> existing reconciliation/uncertainty behaviour;
- failed protection setup never falls back to direct execution.

## Latency requirement

Gateway planning and routing must remain cheap relative to network/tool latency.

- Classification/planning occurs at setup when possible.
- Invocation-time direct routing should add only a thin local function call.
- Invocation-time protected routing should add no additional protection engine beyond the existing Connect/local path.
- No LLM/classifier network call is permitted in the hot execution path for v1.

## Privacy and secrets

Gateway plans and errors must not retain:

- raw tool arguments;
- results;
- auth headers;
- API keys/tokens/passwords;
- provider credentials;
- arbitrary runtime/client objects.

Tool input is passed to the chosen execution path but is not added to the Tool Graph merely because the gateway saw it.

## Local/distributed boundary

The first Phase 11E implementation is a local broker over the existing same-machine protection boundary.

Protected local execution therefore retains the current requirement:

- Node.js 24.15+ for the local SQLite protection path;
- callers that need shared protection must share the same durable local SQLite state;
- this is not a multi-host exactly-once claim.

A future remote/shared gateway may reuse the same route plan while delegating `PROTECT` to a shared Once runtime. That is outside the first 11E slice.

## Framework integration

Framework adapters should stay thin.

The preferred pattern is:

1. framework constructs/selects its normal model-visible tool subset;
2. Once gateway wires only that subset;
3. framework exposes the returned gateway registry/tools, not the originals;
4. the model sees the same intended tool subset and schemas;
5. direct tools stay direct;
6. consequential tools use Once protection;
7. unresolved tools do not silently bypass.

Framework-native gateway adapters may follow only after the framework-neutral/local contract is proven.

## Proposed implementation sequence

### 11E-A — deterministic gateway planner

- introduce `DIRECT | PROTECT | BLOCK` gateway route model;
- reuse Connect normalization/classification;
- safe descriptor fingerprints;
- ordered partitions and summary;
- pure/no-execution/no-I/O regression corpus.

### 11E-B — local gateway toolset broker

- exact manifest-to-registry preflight;
- whole-selected-toolset fail-closed wiring;
- direct wrappers for `DIRECT`;
- existing Connect wrappers for `PROTECT`;
- no wrapper returned for unresolved toolsets;
- immutable returned registry/plan.

### 11E-C — Tool Graph binding

- optional binding to existing Phase 11 observations;
- exact identity/fingerprint checks;
- stale/conflicting observations fail closed;
- evidence/action priority retained for reporting but never used to downgrade protection.

### 11E-D — framework-native broker proof

Start with OpenAI Agents/FunctionTools because Connect already has a structural adapter, then evaluate Vercel/LangChain only if the framework-neutral broker contract remains simple.

### 11E-E — packed-artifact/end-to-end closure

Prove from a freshly installed npm tarball:

- direct tool executes once without protection state;
- protected tool executes once and confirmed retry replays without a second effect;
- unresolved toolset cannot be wired;
- changed effect payload conflicts;
- model-visible subset remains the supplied subset rather than expanding to the global Tool Graph;
- ESM/CommonJS/TypeScript gateway exports are usable from the package artifact.

## Phase 11E invariant

> The gateway may decide **how** an already-selected tool invocation is routed. It must not silently decide **that** a consequential action is authorized, and uncertainty must never become direct execution.

## Exit condition

Phase 11E is complete when Once can take a runtime-selected tool subset, deterministically route harmless invocations directly, route qualifying consequential invocations through the existing Once protection engine, block unresolved routing, preserve exact Tool Graph identity, and prove the behaviour from the publishable package artifact — without expanding model context or introducing a second execution engine.

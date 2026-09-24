# Product adoption hardening: local engineering record

## Baseline and evidence

The published TypeScript SDK is 0.1.6. Its quick start requires installing
the SDK, obtaining/loading `ONCE_API_KEY`, configuring or selecting a hosted
provider, choosing a stable `operationId`, binding an action, changing the
callsite to `once.execute`, and testing the actual provider effect. That is at
least six meaningful decisions/actions before a verified safe effect. The
repository had no measured clean-user TTFSE for this route; a truthful number
cannot be inferred without credentials and a registered provider. A heading
calling it a "60-second quick start" did not establish that time.

Adoption-v1 is frozen and was not modified. Two Cold agents passed by building
bespoke durable machinery; a third Cold agent made its store path mandatory at
the wrong boundary. Warm agents found and understood Once, but their required
key/provider configuration changed the existing caller contract and the
fixture never reached safety semantics. This shows integration friction, not
that Once's hosted recovery kernel is defective. It also does not prove a
local wrapper works across hosts or providers.

| Friction | Classification | Why |
| --- | --- | --- |
| Stable logical action ID | Essential safety requirement | Payload alone cannot distinguish intentional same-payload actions. |
| Complete effect-bearing payload | Essential safety requirement | Required to reject changed meaning under one ID. |
| Durable state | Essential safety requirement | Process memory cannot protect restart retries. |
| Provider truth for ambiguous recovery | Essential safety requirement | Timeouts and missing acknowledgements do not prove absence. |
| Hosted API key before first local proof | Advanced configuration exposed too early | A local durable boundary can prove a narrower guarantee. |
| Registered provider before wrapping an existing function | Product limitation | The application already owns the provider object. |
| Application caller signature changed for hosted integration | Unnecessary friction in common local path | A higher-order async wrapper can preserve arguments. |
| Node version needed for built-in SQLite | Product limitation | Local path requires Node 24.15+; hosted path remains available on older Node. |

## Design choice

| Option | Experience | Safety and limits | Decision |
| --- | --- | --- | --- |
| Keep hosted provider-first execution | Mature distributed boundary | Requires key, provider alias, and action mapping | Keep for distributed/advanced use. |
| Global interception or automatic action inference | Few edits | Cannot reliably infer logical identity, full payload, or all provider writes | Reject as a safety default. |
| Generated source migration | Can preserve surface | Framework-specific and difficult to guarantee every consequential path was changed | Later tooling, not first path. |
| Local wrapper over built-in SQLite | Keep async arguments; two safety selectors | One-machine only; ambiguity blocks without authoritative truth | Implement as opt-in first-value path. |

The local wrapper writes a `CLAIMED` record transactionally before dispatch.
It binds the ID to a canonical payload fingerprint and stores a JSON-safe
result on confirmation. A retry of `CONFIRMED` replays; an in-flight retry
blocks; an expired, failed, or crashed claim becomes `UNKNOWN`. An optional
provider lookup may confirm the result. `UNKNOWN` and `CONFLICT` never
authorize dispatch. An `ABSENT` lookup also does not authorize redispatch in
this local version: a late original write can still commit, and the wrapper
has no provider idempotency protocol. This conservative choice trades liveness
for the one-effect safety boundary.

The default file is `.once/operations.sqlite`; explicit `statePath` is an
override for applications with unstable working directories. SQLite WAL,
full synchronous mode, and `BEGIN IMMEDIATE` coordinate cooperating local
processes using the same durable file. The path must be kept across restarts.
This is not shared multi-host coordination, provider atomicity, or a universal
exactly-once claim. The wrapped async function must be the route used by all
callers; another direct call can bypass it.

The design follows a narrow lesson from [Stripe's idempotent request contract](https://docs.stripe.com/api/idempotent_requests):
bind one retry identity to one parameter set and reject drift. Stripe's
documented pruning window also reinforces that the identity retention horizon
must be explicit. [OpenTelemetry's zero-code guidance](https://opentelemetry.io/docs/zero-code/js/)
shows how auto instrumentation can lower setup cost, but its
[scope guidance](https://opentelemetry.io/docs/concepts/instrumentation/zero-code/)
explains why application-specific behavior often still needs code. Once
cannot infer an intentional logical action solely from a network request.

## Activation and proof

`examples/local-function/verify.mjs` is the controlled first proof. A clean
offline package trial took 2.524 seconds to pack and install a locally built
SDK tarball and 0.226 seconds to run the four-case external-effect check on
Node 24.19.0. This excludes the time a person or agent takes to choose the
correct ID and payload, so it is **not** a measured end-to-end human TTFSE.
The new common local path has three meaningful decisions: choose ID, choose
effect-bearing payload, and choose/accept a durable local state path. It needs
no key or provider registration for the first controlled proof. Production
readiness also requires provider-specific reconciliation and topology review.

## Supply chain and distribution notes

Locally, TypeScript SDK is 0.1.6, MCP is 0.1.3 and pins SDK 0.1.5, and Python
project metadata is 0.1.0. The new local API is source-only and not in
published 0.1.6. The repository CI is test-focused and has no npm/PyPI
publishing or provenance workflow visible here. Release owners should check
actual registry provenance, version alignment, and public artifact contents
before any publication; this mission does not publish. The MCP metadata names
the registry identity and 0.1.3, but its installed registry state was not
verified by this local audit. Existing OpenAI Agents, Vercel AI SDK,
LangGraph, CrewAI, Microsoft Agent Framework, MCP, Codex, Claude Code and
Cursor materials remain documented; adding more logos would not address this
caller-boundary failure.

## Adoption-v2 proposal (not run)

Freeze a versioned fixture, prompts, model conditions, evaluator, and evidence
rules before candidates execute. Include existing async caller signatures
with supplied provider objects and no preconfigured Once key; also include a
distributed scenario where hosted configuration is genuinely needed. Require
independent same-payload actions, payload conflict, effect-then-lost-response,
restart, and parallel instances. Count actual provider effects, inspect
`UNKNOWN` and `CONFLICT` errors, and test whether the existing caller can still
invoke the function. Record TTFSE from the first repo view and count decisions,
commands, manual edits, and intervention. Separate discovery, integration,
activation, and proof failures. Do not expose private evaluator answers in
candidate prompts or reuse Adoption-v1 results as editable fixtures.

## Open risks

The built-in SQLite API is a Node 24 release candidate, so a dedicated Node
24.15 CI gate is needed. A provider object can still be called directly from
unwrapped code. The default path can be lost on ephemeral deployment volumes.
Long-running calls may outlive a claim lease; the wrapper then blocks or
reconciles rather than redispatching. Result replay supports JSON-safe values,
not class instances or streams. A resolved result must represent confirmed
provider completion, rather than mere queue acceptance. Provider lookup
callbacks are application
supplied and must be authoritative; a stale or dishonest `CONFIRMED` response
can misreport the result. The local wrapper does not yet offer safe liveness
after authoritative `ABSENT`; a provider-idempotent integration would need a
separate protocol and hostile tests.

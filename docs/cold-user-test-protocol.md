# Once Cold-User Test Protocol v1

Status: frozen protocol candidate for Phase 16 / issue #184.

## Purpose

Measure whether a new user or coding agent can discover, install, understand, and safely reach a useful Once outcome using only public instructions.

This is an adoption and protection-evidence protocol. It is not a benchmark for making Once look good. A failure, BLOCK, UNKNOWN, unsupported shape, or abandoned setup is valid evidence and must be recorded as observed.

## Success targets

Phase 16 tracks three separate targets:

1. 10 independent cold installs.
2. 3 real integrations.
3. 1 independently observable production-style consequential operation protected by Once.

A single test may count toward more than one target only when it genuinely satisfies each definition below.

## Definitions

### Independent cold tester

A person or coding agent that has not previously been walked through the tested Once flow by a maintainer and does not receive private setup instructions during the run.

A maintainer may recruit the tester and provide the public starting link or public install command. After the timer starts, maintainer hints, private commands, unpublished patches, direct environment edits, or secret troubleshooting instructions end the cold portion of the run.

### Cold install

A test starting from an environment where Once is not already configured for the target project. Existing system software is allowed, but any pre-existing Once project state must be declared.

### Real integration

A test against an actual user project or realistic external integration surface rather than a repository-owned synthetic fixture alone.

### Production-style consequential operation

An operation representative of a real side effect where accidental duplicate execution would be undesirable or costly. It does not need to target a production account, but the operation and retry ambiguity must be realistic and independently observable.

## Frozen-test rule

Record the protocol version, Once version, public instruction source, and start timestamp before the tester begins.

Do not change this protocol during a run to improve the result. If the protocol itself is defective, finish or stop the run, record that fact, then revise the protocol for a later numbered run.

Do not retroactively reinterpret a failure as success.

## Privacy and data minimisation

Never record or paste:

- API keys
- passwords
- cookies
- tokens
- Authorization header values
- request bodies containing user or customer data
- full environment files
- private source code that is not necessary to explain the outcome
- personal or customer information that is not necessary for the test

Allowed evidence should be limited to timestamps, versions, command names, redacted error categories, route/outcome categories, high-level environment information, and non-sensitive screenshots or logs when useful.

If a secret appears in captured output, redact it before storing the evidence. Do not commit secret-bearing evidence to the repository.

## Permanent safety constraints

The test must not weaken Once in order to improve completion rates.

During a test, do not:

- change UNKNOWN into permission to execute
- bypass a BLOCK result manually and then count the operation as protected
- copy or preserve source Authorization credentials into a protected action
- broaden the transformer or runtime allowlist without a separate pinned proof contract
- disable durable replay, reconciliation, identity binding, or conflict checks
- treat an unsupported shape as automatically safe
- count autoprotection surface coverage as an accuracy percentage

A safe refusal is preferable to an unsafe successful-looking run.

## Required test metadata

Before starting, record:

- evidence ID
- tester identifier or anonymous tester label
- date and timezone
- operating system
- Node/Python/runtime versions relevant to the attempted flow
- Once package/version or exact public artifact used
- target project/framework/host/provider category
- whether the tester has used Once before
- whether the target project already contains `.once` state
- public instruction source used

Do not record credentials.

## Timer definitions

Use one monotonic or wall-clock source consistently for the run.

Record these timestamps when applicable:

- `T0_START`: tester receives the public starting instruction and begins.
- `T1_INSTALLED`: Once installation completes successfully.
- `T2_FIRST_USEFUL`: the first Once output that gives the tester an actionable or understandable result, such as protection readiness, a plan, a clear BLOCK/UNKNOWN reason, or a valid next action.
- `T3_FIRST_PROTECTED`: the first consequential action for which the current flow truthfully reaches verified protected status under Once's existing claim boundary.
- `T4_END`: run completes, is abandoned, or is stopped.

Derived measurements:

- install time = `T1_INSTALLED - T0_START`
- time to first useful result = `T2_FIRST_USEFUL - T0_START`
- time to first protected action = `T3_FIRST_PROTECTED - T0_START`
- total run time = `T4_END - T0_START`

If a milestone is never reached, record `NOT_REACHED`; do not invent a duration.

## Test procedure

### 1. Freeze the starting state

Record the required metadata and `T0_START`.

Confirm that the tester will use only public Once instructions during the cold portion of the run.

### 2. Install Once

The tester follows the current public installation path without maintainer intervention.

Record:

- success or failure
- `T1_INSTALLED` if successful
- the public instruction that was unclear if installation fails
- a redacted error category if applicable

Do not repair the environment for the tester and continue counting the same run as cold. If intervention is required, record `MAINTAINER_INTERVENTION_REQUIRED` and end the cold portion.

### 3. Run the public front-door flow

The tester uses the public/default Once entry path appropriate to the current release.

Record `T2_FIRST_USEFUL` when the tester first receives a meaningful, actionable Once result.

Record the observed outcome category:

- `PROTECTION_READY`
- `PLAN_CREATED`
- `BYPASS`
- `BLOCK`
- `UNKNOWN`
- `UNSUPPORTED`
- `ERROR`
- `ABANDONED`

Do not translate BLOCK or UNKNOWN into success.

### 4. Attempt one realistic consequential integration

The tester attempts one side-effecting operation where duplicate execution would be undesirable.

Record only the high-level operation class, for example:

- create/update/delete an external HTTP resource
- send a message or email
- create/update a provider object
- invoke a consequential MCP tool
- perform another clearly side-effecting operation

Do not record the sensitive payload.

### 5. Record Once's decision

Classify the observed result using the narrowest applicable outcome:

- `PROTECTED` — the current source/configuration and required proof conditions satisfy Once's truthful protected claim boundary.
- `BYPASS` — Once correctly determines duplicate-effect protection is not applicable to this operation.
- `BLOCK` — Once deliberately refuses execution/protection because a required safety condition is unresolved or conflicting.
- `UNKNOWN` — authoritative truth is insufficient after an ambiguous outcome; Once remains fail-closed.
- `UNSUPPORTED` — the discovered shape/integration is outside the proven automatic protection surface.
- `ERROR` — tooling/setup failed before a meaningful safety disposition was produced.
- `ABANDONED` — tester stops before completion.

If `PROTECTED`, record `T3_FIRST_PROTECTED`.

### 6. Test understanding

Without coaching, ask the tester to explain in their own words why Once protected, bypassed, blocked, or remained unknown.

Record only a short paraphrase and whether their understanding was:

- `CLEAR`
- `PARTIAL`
- `INCORRECT`
- `NOT_ASSESSED`

Do not correct them until after their answer is captured.

### 7. End the cold run

Record `T4_END` and the final outcome.

If maintainer intervention is now desired, start a separate assisted follow-up section. Do not overwrite the cold result.

## Stop conditions

End the cold portion immediately and record the reason if any of these occur:

- tester requests or requires private maintainer instructions
- a credential or secret would need to be shared with the maintainer
- the only way forward appears to require weakening a fail-closed boundary
- a real external action might be duplicated without a proven Once protection path
- the environment becomes materially different because a maintainer edits it
- the tester chooses to abandon the flow

## Evidence quality rules

Every evidence record must distinguish observation from interpretation.

Good observation:

> `UNKNOWN` returned after ambiguous provider outcome; no second effect observed.

Bad interpretation:

> Once basically worked.

Record exact public versions and timestamps when available. Prefer short redacted excerpts over full logs.

## Counting rules

### Count as a cold install

Count only when the cold-install definition is met and the tester reaches either a successful installation or a clearly attributable install failure using public instructions. Record failures; do not exclude them from the denominator.

### Count as a real integration

Count only when the tester attempts Once on an actual user project or realistic external integration surface. Synthetic repository fixtures alone do not count.

### Count as the production-style protection proof

Count only when:

- the operation is consequential and realistic
- the protected route is independently observable
- Once's current verification/receipt requirements are satisfied
- duplicate-effect safety is demonstrated under the applicable retry/ambiguity model
- no maintainer-only patch or safety bypass was needed during the evidence-producing run

## Post-run decision rule

Do not choose the next engineering task before reviewing the evidence.

Classify the dominant friction as one or more of:

- `INSTALL`
- `DISCOVERY`
- `UNDERSTANDING`
- `AUTO_WIRING`
- `UNSUPPORTED_SHAPE`
- `IDENTITY_BINDING`
- `PROVIDER_TRUTH`
- `VERIFICATION`
- `LATENCY`
- `DOCUMENTATION`
- `OTHER`

Prioritise product changes by repeated observed friction, user impact, and whether the change can be proven without weakening Once's execution-safety boundary.

## Related tracking

Phase 16 adoption tracking: GitHub issue #184.

The companion evidence form is `docs/cold-user-evidence-template.md`.
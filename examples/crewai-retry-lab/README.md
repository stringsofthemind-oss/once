# CrewAI hostile-retry portability lab

This lab tests the frozen Once V4 framework-neutral recovery core against
CrewAI's native tool conversion/invocation boundary.

The core and SQLite store are imported from the local SDK and are not modified.

## What is actually exercised

The deterministic path is:

```text
CrewAI BaseTool
  -> to_structured_tool()
  -> CrewStructuredTool.ainvoke()
  -> bound _run()
```

The harness controls fresh-process redispatch itself instead of using an LLM or
external orchestrator. This avoids network/API nondeterminism while preserving
the hostile failure boundary: the provider commits an external effect and the
process immediately terminates with `os._exit(77)` before the framework can
receive a successful tool result.

The provider intentionally does **not** provide idempotent execution. A second
write would therefore create a second row in `provider.sqlite`.

## Evidence matrix

```text
CASE A  CONTROL
  first process commits effect and dies
  fresh process redispatches same logical action
  expected -> 2 effects -> DUPLICATED

CASE B  ONCE
  CLAIMED is durable before provider execution
  provider commits effect and process dies
  fresh process reconciles provider truth
  expected -> 1 effect -> CONFIRMED

CASE C  UNKNOWN
  provider truth unavailable during recovery
  adapter returns CrewAI ToolFailure(code="once_outcome_unknown")
  expected -> 1 effect -> UNKNOWN / BLOCKED

CASE C2 RECOVERY
  provider truth restored
  fresh process redispatch reconciles UNKNOWN -> CONFIRMED
  expected -> still 1 effect
```

## Logical identity boundary

`crewai_identity_boundary.py` pins a separate adoption boundary that is easy to
miss when idempotency is derived from tool arguments alone:

```text
logical operation identity != payload identity
```

The caller supplies a logical operation ID minted before execution. The same
payload may therefore represent either a retry of existing work or a genuinely
new action.

The regression proves all four cases through CrewAI's native structured-tool
path:

```text
D1  action A: operation_id=A, payload=$42 -> execute -> 1 effect
D2  retry A:  operation_id=A, payload=$42 -> replay  -> still 1 effect
D3  action B: operation_id=B, payload=$42 -> execute -> 2 effects
D4  drifted A: operation_id=A, payload=$84 -> conflict -> still 2 effects
```

This is why an example such as `charge:{order_id}` is safe only when the domain
contract guarantees one admitted charge for that order. If two intentionally
identical charges are valid business actions, each admitted action needs its own
stable logical operation identity created before the external effect.

## Run

From this directory:

```powershell
py -m pip install -r .\requirements.txt
py .\crewai_v4_regression.py run
py .\crewai_identity_boundary.py
```

The scripts import the local Once SDK directly from `../../sdk/python/src`, so
they test the repository copy rather than a published package.

Expected hostile-retry summary:

```text
PASS: Once V4 CrewAI portability regression gate held.
CASE A  CONTROL    -> 2 effects -> DUPLICATED
CASE B  ONCE       -> 1 effect  -> CONFIRMED
CASE C  UNKNOWN    -> 1 effect  -> BLOCKED
CASE C2 RECOVERY   -> 1 effect  -> UNKNOWN->CONFIRMED
```

Expected logical-identity summary:

```text
CASE D1 A execute        -> effects=1
CASE D2 A retry          -> effects=1
CASE D3 identical B      -> effects=2
CASE D4 drifted A        -> effects=2 failure=once_operation_conflict
PASS: A executes once; retry A replays; identical B executes as new work; drifted A is rejected.
```

The same logical-identity invariant is also pinned by the offline Python SDK
unit regression in `sdk/python/tests/test_logical_identity_boundary.py`, so the
core boundary is exercised by SDK CI without requiring CrewAI or an API key.

## Scope

This proves portability across CrewAI's current native structured-tool boundary
and fresh-process redispatch, plus the distinction between logical operation
identity and payload equality. It does not claim that CrewAI itself survives
`os._exit(77)` or automatically restarts a killed process; the harness models
the external worker/orchestrator redispatch explicitly.

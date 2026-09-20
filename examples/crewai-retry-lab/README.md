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

## Run

From this directory:

```powershell
py -m pip install -r .\requirements.txt
py .\crewai_v4_regression.py run
```

The script also imports the local Once SDK directly from
`../../sdk/python/src`, so it tests the repository copy rather than a published
package.

Expected final summary:

```text
PASS: Once V4 CrewAI portability regression gate held.
CASE A  CONTROL    -> 2 effects -> DUPLICATED
CASE B  ONCE       -> 1 effect  -> CONFIRMED
CASE C  UNKNOWN    -> 1 effect  -> BLOCKED
CASE C2 RECOVERY   -> 1 effect  -> UNKNOWN->CONFIRMED
```

## Scope

This proves portability across CrewAI's current native structured-tool boundary
and fresh-process redispatch. It does not claim that CrewAI itself survives
`os._exit(77)` or automatically restarts a killed process; the harness models
the external worker/orchestrator redispatch explicitly.

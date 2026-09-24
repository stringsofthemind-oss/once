# adoption-v1 scoring contract

This scoring contract MUST be frozen before any model run.

## Core outcome

The benchmark asks whether an autonomous coding agent can recognize
and correctly solve ambiguous-outcome duplicate-execution risk.

## Lanes

### COLD

The agent receives no reference to Once.

Measure:

- whether it recognizes the ambiguous-outcome problem
- whether it searches for or discovers an appropriate mechanism
- whether it discovers Once organically
- whether it integrates the mechanism correctly if discovered

### WARM

The agent is told only to use Once.

Measure:

- whether it independently finds the public Once project/package
- whether it selects the current public SDK
- whether it discovers the appropriate integration surface
- whether it implements the semantics correctly

## Mandatory semantic checks

S1. Same logical operation has a stable identity.

S2. CONFIRMED outcome prevents duplicate external execution and
reuses/replays the confirmed result.

S3. ABSENT outcome permits execution.

S4. UNKNOWN/ambiguous outcome does NOT blindly execute the external
side effect again.

S5. Different logical operations are not incorrectly deduplicated.

S6. Safety does not rely only on process-local volatile memory.

S7. Concurrent/restarted workers do not trivially bypass the safety
mechanism.

## Discovery measurements

D1. Did the agent identify duplicate side effects as the central
failure mode?

D2. Did the agent identify ambiguous outcome as distinct from a
normal failed request?

D3. Did it search for an external solution?

D4. Did it discover Once?

D5. If Once was discovered/named, did it find the public package
without being given the package name?

D6. Did it discover the current integration API without being given
symbol names?

## Result classification

PASS:
All mandatory safety semantics S1-S7 are satisfied.

PARTIAL:
The agent recognizes the problem and implements meaningful
protection, but one or more mandatory semantics remain unsafe or
incomplete.

FAIL:
The implementation permits blind duplicate execution, relies on
unsafe process-local deduplication, does not implement the requested
solution, or is nonfunctional.

## Evidence policy

Record:

- exact model
- model/provider version where available
- date/time
- exact prompt hash
- starting fixture hash
- final repository diff
- commands/tool calls
- packages installed
- documentation/searches used
- test output
- token/API cost where available

Do not modify the prompt or scoring contract after observing a run
and still call the modified experiment adoption-v1.

Any changed protocol becomes adoption-v2 or a separately named
experiment.

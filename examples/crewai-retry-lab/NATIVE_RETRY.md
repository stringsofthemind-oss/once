# CrewAI #5802: native task retry and bounded recovery evidence

The existing lab proves structured-tool invocation plus externally controlled
redispatch. `native_retry.py` adds an actual `Agent.execute_task` failure/retry
without patching CrewAI's agent, executor, tool invocation, cache, or retry code.
It also checks process death separately. No SDK production code changes.

## Reproduce with the published Python SDK

From this directory, using Python 3.12:

```powershell
python -m venv .venv-native
.venv-native/Scripts/python -m pip install -r requirements-native.txt
.venv-native/Scripts/python native_retry.py --evidence native-evidence.json
```

On Linux/macOS use `.venv-native/bin/python`. No API key, model endpoint, real
payment account, or external service is required. The provider is a local
simulation with a separate durable SQLite database. CrewAI's event loop needs
local loopback sockets; an environment blocking those can hang before execution.

The direct dependencies are pinned to the existing lab's `crewai==1.15.22` and
published `once-agent-sdk==0.1.1`. The script does **not** insert the repository
SDK path and verifies its import matches the installed distribution. Evidence
records versions, core origin, core hash, harness hash, counts, and pass/fail.
Transitive dependencies are not locked by `requirements-native.txt`; record them
with `python -m pip freeze --all` for an exact environment record. The dedicated
CI workflow retains this alongside JSON evidence for Windows/Linux and
published/checkout-wheel consumers.

To validate a built checkout in a separate clean environment, install the same
requirements there, then run:

```powershell
python -m pip install --no-deps --force-reinstall ../../sdk/python
python native_retry.py --evidence checkout-wheel-evidence.json
```

Use the new environment's Python. This builds and installs a wheel, not an
editable source import. The two SDKs share a version number; version alone does
not establish equivalence. Compare the recorded core hashes and package origin.

## Native failure sequence

1. The application invokes `Agent.execute_task(task)` exactly once, with
   `max_retry_limit=1`, caching disabled, and a deterministic `BaseLLM` subclass.
2. CrewAI parses the scripted ReAct tool request and invokes `PaymentTool`.
3. The independent provider commits a payment row, then raises
   `AmbiguousProviderOutcome` **before returning a receipt**. The adapter exposes
   a non-retryable `ToolFailure` with an explicit unknown outcome.
4. The next scripted model call raises an executor exception. CrewAI's real
   task-error handler increments `_times_executed` and calls `execute_task` again.
5. The script requests the same admitted intent. The unprotected control writes
   again. Once reconciles the original provider row and returns that receipt.

Assertions require two actual tool-body invocations, four model calls, exactly
one native task retry, an unknown observation before retry, a real receipt after
retry, and the separate provider row count. The generated final-answer text is
not used as evidence of payment success. The model is scripted; model behaviour
and live model/provider reliability are not measured. There are two deliberate
faults: the lost provider acknowledgement and the subsequent executor error.
This does not claim that returning `ToolFailure` alone restarts a task.

## Regression matrix

| Case | Expected and locally observed result |
| --- | --- |
| Native task retry, control | 2 tool calls, 1 task retry, **2 provider effects** |
| Same native retry, Once | 2 tool calls, 1 task retry, **1 effect**, RECONCILED |
| 8 spawned processes released at a barrier | 1 effect; 7 IN_FLIGHT refusals while winner is held after commit |
| Same ID with changed payer, recipient, amount, currency | 12 CONFLICT cases across CLAIMED, UNKNOWN, CONFIRMED; no added effects or record mutation |
| Distinct admitted IDs, identical fields | 2 effects; retry of A returns A's original receipt |
| Lost provider response; lookup unavailable | UNKNOWN; three retries blocked at 1 effect; restored truth reconciles; later replay preserves receipt |
| Confirmed record, attempted recovery/reacquisition after time advance | Four current/stale-version transition refusals; record and receipt retained; 1 effect |
| Expired claim, no provider effect, non-idempotent provider | ABSENT does not authorize redispatch; 0 effects and no false CONFIRMED result |
| `os._exit(77)` after provider commit, before Once confirmation | Fresh worker: control 2 effects; Once 1 effect and RECONCILED |
| `os._exit(79)` after Once confirmation, before tool response | Fresh worker: 1 effect; REPLAYED original receipt |

Both hard-exit cases require the exact exit code and absence of a worker output
file. Redispatch is **harness-owned**, not CrewAI resurrecting a dead process.
For the unconfirmed crash, the retry worker's injected test clock advances
120001 ms past a 120000 ms lease. No record is deleted or reset. This tests an
expired lease deterministically, not real-time waiting or clock-skew tolerance.
The concurrent case uses ordinary wall time and a held provider response.

## Release and trust boundaries

Python `OnceCore`/`SQLiteOperationStore` exposes no operator release, force,
delete, or TTL-eviction API. Therefore this is **not** a test of a hypothetical
`release(force=True)` feature. It tests the actual `mark_unknown` and
`reacquire_after_absent` transitions against a CONFIRMED record, and the normal
core recovery route for unknown/expired claims. These transitions cannot clear
the tested confirmed effect. Low-level storage methods are trusted protocol
primitives, not an authorization API; invoking reacquisition directly on an
unconfirmed record does not establish provider absence or safe redispatch.

The provider intentionally has no idempotency constraint on operation ID. A
second dispatch creates a second row. Its lookup is authoritative only within
this local fixture and checks the bound fingerprint. A real integration needs
equally authoritative read-only provider truth; missing receipts alone do not
prove absence. Once's safe redispatch rule also requires provider idempotency.
Use native provider idempotency or a database constraint if that fully solves
the operation.

The caller admits the logical operation ID before execution and retains it on
retry. Payer/account, recipient, amount in integer minor units, and currency are
all fingerprint-bound independently of identity. Identical intentional payments
use distinct IDs. The fixture is one trusted host with a persistent shared
SQLite authority and cooperating processes. It does not cover multi-host
storage, dishonest provider truth, state deletion/rollback, arbitrary code
modifying records, hidden provider retries, live payments, arbitrary argument
canonicalization, or universal exactly-once execution.

## Local validation and upstream status (2026-11-05)

Starting Once commit: `8381734a9be368138546121ae708ec9c55be8e89`.
Windows, Python 3.12.10, CrewAI 1.15.22. Published Python SDK 0.1.1 is the latest
version reported by PyPI at the time of the run. Both the published consumer and
a separately installed checkout-wheel consumer passed all 10 tests. Their loaded
core files had SHA-256
`aa37acded51c75a08edfd9d81350f725b1cfe292336d833bec1506cdc8bb65d6`.
This establishes equivalence for that core file, not every package file.
Linux/remote CI results, when available, are separate evidence.

The existing hostile-retry and identity labs pass. The checkout's Python SDK
suite passes 44 tests. Repository-required FIRST 10, packed FIRST 10, tool-wrapper,
packed wrapper, local SQLite, generated-proof and site-surface checks were also
run; these are separate regressions, not extra CrewAI proof cases. Initial
restricted runs could not use loopback sockets/fetch the public proof asset;
normal local execution passed. No SDK fix was necessary for these tested paths.

[CrewAI #5802](https://github.com/crewAIInc/crewAI/issues/5802) is open.
[PR #5822](https://github.com/crewAIInc/crewAI/pull/5822) is open/unmerged at
`e094bad613806c036a734409dee11c666670ed6d`.
[PR #6048](https://github.com/crewAIInc/crewAI/pull/6048) is open/unmerged at
`9a969dd3895fa5c788e1b7ba860a9aa6041d5040`. The latter now describes atomic claims,
scoped task retries, explicit unknown outcomes, and a pluggable backend; earlier
race reports must not be presented as findings against its current head. Neither
PR head was executed by this lab; this is not a comparison or verdict on them.

[Once FIRST 10 #294](https://github.com/stringsofthemind-oss/once/issues/294)
requests independent cold developer evaluations and remains open with no comments
at inspection. This owner-assisted, AI-assisted fixture work is not an independent
adopter, a real deployment, or retention evidence. No FIRST 10 ledger is changed.

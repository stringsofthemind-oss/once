# LangGraph hostile-retry lab

A runnable reproduction of a dangerous retry boundary:

> An external side effect succeeds, but the process loses the acknowledgement
> before local state is durably checkpointed.

The retry then has to answer:

**Did the first attempt actually happen?**

This lab separates simple idempotency from outcome reconciliation and includes
both a framework-independent fixture and a real LangGraph crash/restart test.

No API credentials are required. No real payments or external writes occur.

## Files

- `hostile_retry.py` — framework-independent four-scenario proof.
- `langgraph_retry.py` — real LangGraph + `SqliteSaver` + hard-process-restart proof.
- `requirements.txt` — pinned LangGraph test dependencies.

## Version 1: four execution-safety scenarios

Run:

```bash
python hostile_retry.py
```

Expected result:

```text
SCENARIO 1  naive-random-uuid  external_effects=2  result=DUPLICATED
SCENARIO 2  deterministic-identity  external_effects=1  result=DEDUPED
SCENARIO 3  ambiguous-ack  external_effects=1  recovery=RECONCILED  result=CONFIRMED
SCENARIO 4  unresolved-provider-truth  external_effects=1  recovery=BLOCKED  result=UNKNOWN

PASS: all hostile-retry invariants held.
```

### Scenario 1 — random UUID inside the node

The node generates a fresh operation key before the external write.

If the provider succeeds and the process dies before that key is checkpointed,
a retry starts from prior state and generates another key.

Result: two external effects are possible.

### Scenario 2 — deterministic business identity

The operation key is derived from business identity that existed before the
attempt, for example:

```python
def stable_operation_key(order_id: str) -> str:
    return f"charge:{order_id}"
```

When the provider supports idempotency for that key, the retry is recognized as
the same logical operation.

Result: one external effect.

A stable key alone does not make an arbitrary provider idempotent.

### Scenario 3 — ambiguous acknowledgement and reconciliation

The provider commits the effect but the local acknowledgement is lost.

On recovery, the execution layer queries authoritative provider truth rather
than assuming that missing local state means the external action failed.

Result:

```text
external_effects=1
recovery=RECONCILED
result=CONFIRMED
```

### Scenario 4 — unresolved provider truth

If the first request may have committed but authoritative provider truth is
unavailable or indeterminate, the lab preserves uncertainty.

Result:

```text
external_effects=1
recovery=BLOCKED
result=UNKNOWN
```

`UNKNOWN` is intentional. Uncertainty is not evidence that repeating an
irreversible action is safe.

## Version 2: real LangGraph process-crash test

Install:

```bash
python -m pip install -r requirements.txt
```

Run:

```bash
python langgraph_retry.py
```

Version 2 uses three independent durability boundaries:

```text
langgraph.sqlite
    = LangGraph checkpoint truth

provider.sqlite
    = simulated external-provider truth

fresh Python child process
    = no in-memory state survives restart
```

The node performs the provider write and immediately executes:

```python
os._exit(77)
```

This bypasses normal exception handling and cleanup after the provider
transaction has committed.

The supervisor then launches a completely fresh Python process against the same
LangGraph and provider SQLite files and resumes the same LangGraph thread with:

```python
graph.invoke(None, config, durability="sync")
```

The verdict is determined from the independent provider ledger, not from
LangGraph state.

### Naive variant

```text
attempt 1
UUID A
provider effect #1
hard crash

fresh process
resume same LangGraph thread
UUID B
provider effect #2
```

Expected verdict:

```text
DUPLICATED
```

### Stable-identity variant

```text
attempt 1
charge:order_123
provider effect #1
hard crash

fresh process
resume same LangGraph thread
charge:order_123
provider-supported dedupe
```

Expected verdict:

```text
ONE_EXTERNAL_EFFECT
```

## What the lab establishes

```text
stable identity
    !=
proof an external effect occurred

durable claim
    !=
external settlement receipt

missing local result
    !=
proof the external operation failed

UNKNOWN
    !=
permission to execute again
```

## Relationship to LangGraph

The lab does not claim that LangGraph itself guarantees duplicate side effects.

The narrower point is:

Application code that performs external mutations inside retryable or resumable
execution must preserve stable operation identity and must not infer external
truth solely from local checkpoint state.

## Relationship to Once

The framework-independent recovery layer is intentionally small and educational.
It demonstrates the execution model behind Once:

```text
stable operation identity
        ↓
durable operation state
        ↓
external execution
        ↓
provider truth / reconciliation
        ↓
CONFIRMED | ABSENT | UNKNOWN
```

It is not the production Once implementation.

Once does not claim universal exactly-once execution. Safety depends on stable
operation identity, durable state, provider behavior, sufficiently authoritative
provider truth, and the supported failure model.

## Core principle

> Do not repeat an irreversible action merely because its acknowledgement was
> lost.

## Verified framework run

The real LangGraph crash/restart fixture was executed successfully on:

```text
Windows
CPython 3.12
LangGraph 1.2.11
langgraph-checkpoint-sqlite 3.1.1
durability="sync"
```

Observed result:

```text
NAIVE
hard crash after provider commit
fresh-process LangGraph resume
final_external_effects=2
verdict=DUPLICATED

STABLE
hard crash after provider commit
fresh-process LangGraph resume
final_external_effects=1
verdict=ONE_EXTERNAL_EFFECT
```

In the naive case, the resumed node generated a different UUID because the
first UUID had never become checkpointed node state.

In the stable case, both executions used `charge:order_123`, so the simulated
provider's idempotency boundary recognized the retry as the same logical
operation and returned the original receipt instead of creating another effect.

This result demonstrates the tested failure boundary. It is not a claim that
all LangGraph retries duplicate side effects.

## Verified reconciliation run

The reconciliation edition was executed successfully with real LangGraph
process restart and three independent SQLite durability boundaries:

```text
langgraph.sqlite  = workflow checkpoint truth
operations.sqlite = logical operation truth
provider.sqlite   = external-world truth
```

Observed framework-level results:

```text
CASE 1  NAIVE
external_effects=2
verdict=DUPLICATED

CASE 2  STABLE
external_effects=1
verdict=ONE_EXTERNAL_EFFECT

CASE 3  RECONCILE
external_effects=1
recovery=RECONCILED
state=CONFIRMED

CASE 4  UNKNOWN
external_effects=1
state=UNKNOWN
verdict=BLOCKED

CASE 4B  RECOVERY
external_effects=1
transition=UNKNOWN->CONFIRMED
recovery=RECONCILED
```

Case 4 demonstrates fail-closed execution when provider truth is insufficient.
Case 4B demonstrates that availability can later recover without repeating the
external side effect.

The key distinction is:

> Checkpoint state tells you what the workflow remembers.
> Reconciliation tells you what reality did.

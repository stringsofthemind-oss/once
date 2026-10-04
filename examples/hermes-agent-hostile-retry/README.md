# Hermes Agent fail-open middleware safety lab

This lab pins the execution-safety seam between Once and the public Hermes Agent
`tool_execution` middleware contract.

It does **not** modify Hermes, replace Hermes room/gateway authority, or claim
that Once provides universal exactly-once execution. The integration sits below
Hermes orchestration, around the actual consequential tool callback.

## Why this boundary is special

Hermes execution middleware is intentionally fail-open for middleware failures.
In the current public implementation, if a middleware callback raises **before**
calling `next_call(...)`, Hermes reports the middleware failure and continues to
the next middleware or base tool.

That is a useful availability policy for ordinary middleware, but a safety
plugin cannot throw `UNKNOWN`, conflict, identity, or state-store failures into
that path: doing so could bypass the safety layer and execute the consequential
tool anyway.

Once therefore uses a different rule for protected Hermes tool calls:

```text
Once can prove execution/replay/reconciliation is safe
    -> call or replay the tool result

Once cannot prove safety
    -> return an intentional blocked tool result
    -> DO NOT raise into Hermes fail-open fallback
    -> DO NOT call next_call
```

The adapter is in:

```text
sdk/python/src/once_agent/hermes.py
```

## Identity boundary

The adapter does not treat Hermes `tool_call_id` as business identity.

The host supplies a stable logical operation ID through an `operation_id`
resolver. For a protected call, Once fingerprints the effective `tool_name` and
all effective tool arguments. Reusing one logical operation ID with changed
arguments conflicts before dispatch.

A model/transport call ID may still be available in the middleware context as
metadata, but it should only be promoted to logical operation identity if the
host contract proves that it survives the retry/failover boundary that matters.

For Hermes Group Chat work, a future upstream integration should prefer the
canonical logical-attempt/admission identity once Hermes exposes that identity
at the plugin execution boundary, rather than synthesizing identity from a
single model call.

## Reconciliation boundary

A protected callback can commit an external effect and then fail before Hermes
receives the acknowledgement. The adapter conservatively treats an exception
after `next_call` dispatch as an ambiguous provider outcome.

Recovery requires provider-specific read-only reconciliation. The callback
returns one of:

- `CONFIRMED` with the original tool result;
- `UNKNOWN` when provider truth is incomplete or unavailable;
- `ABSENT` only when the provider can authoritatively prove absence.

By default, an opaque Hermes callback is **not** declared idempotent by operation
ID. Therefore even authoritative `ABSENT` does not automatically authorize
redispatch. This is deliberate: an earlier in-flight request may still commit.

## Regression cases

`sdk/python/tests/test_hermes_middleware.py` exercises the current safety
contract with a one-frame model of Hermes' public `_run_execution_chain`
semantics:

```text
CONTROL
  middleware raises before next_call
  -> Hermes fail-open path executes base tool once

ONCE / PRE-DISPATCH FAILURE
  operation identity or Once state store fails
  -> normal blocked result
  -> next_call = 0

FIRST EXECUTION
  stable logical identity + effect args
  -> one external effect

REPLAY
  same logical identity + same args
  -> original result
  -> still one external effect

CONFLICT
  same logical identity + changed args
  -> once_operation_conflict
  -> no second effect

LOST ACKNOWLEDGEMENT
  external effect commits
  callback acknowledgement is lost
  -> UNKNOWN
  -> no blind redispatch

RESTART + RECONCILIATION
  fresh OnceCore / same durable SQLite state
  provider confirms the original effect
  -> original result recovered
  -> still one external effect

AUTHORITATIVE ABSENCE / OPAQUE CALLBACK
  provider reports ABSENT
  callback has no provider idempotency guarantee
  -> redispatch blocked
```

## Pinned upstream Hermes runtime proof

The compatibility proof is also run through Hermes' actual
`hermes_cli.middleware.run_tool_execution_middleware`, not only the local model.

CI checks out public Hermes Agent commit:

```text
ea81748579ee1732d214ccb75f91d22208ed623d
```

and runs:

```text
examples/hermes-agent-hostile-retry/hermes_runtime_contract.py
```

The proof imports the exact pinned upstream middleware implementation while
stubbing only the plugin-manager lookup surface, so the real Hermes
`_run_execution_chain` controls fail-open/fallthrough and `next_call` behavior.
It proves:

```text
CONTROL fail-open -> base tool executed once
ONCE pre-dispatch failure -> base tool executed zero times
REPLAY same logical action -> one effect total
CONFLICT semantic drift -> no second effect
LOST_ACK -> UNKNOWN -> restart/reconcile -> one effect total
```

This proves compatibility with the pinned middleware execution contract. It does
not claim that a full installed Hermes gateway, Group Chat authority lifecycle,
or a real external provider has been exercised yet.

## Run

From the repository root:

```bash
python -m pip install -e ./sdk/python
python -m unittest discover -s sdk/python/tests -p 'test_hermes_middleware.py' -v
```

For the pinned upstream runtime proof, provide a checkout of the exact Hermes
commit above:

```bash
python examples/hermes-agent-hostile-retry/hermes_runtime_contract.py /path/to/hermes-agent
```

The repository's `Full Regression CI` workflow runs the Python SDK test suite on
pull requests to `main`, and `Hermes Middleware Runtime Contract` runs the pinned
upstream proof whenever this integration surface changes.

## Minimal Hermes registration shape

The adapter deliberately has no runtime dependency on Hermes. A Hermes plugin
can register the returned callback through the public middleware API:

```python
from once_agent.core import OnceCore, ProviderTruth
from once_agent.hermes import HermesLookupResult, make_hermes_tool_execution_middleware
from once_agent.storage.sqlite import SQLiteOperationStore

core = OnceCore(SQLiteOperationStore("./durable/once-hermes.sqlite"))


def logical_operation_id(tool_name, args, context):
    if tool_name != "send_invoice":
        return None
    # This must come from stable host/business semantics, not a fresh retry ID.
    return f"send-invoice:{args['invoice_intent_id']}"


def reconcile(operation_id, action_fingerprint, args, context):
    # Replace with authoritative provider-specific read-only lookup.
    # Do not infer absence from a timeout or missing local receipt.
    return HermesLookupResult(ProviderTruth.UNKNOWN)


once_tool_execution = make_hermes_tool_execution_middleware(
    core=core,
    operation_id=logical_operation_id,
    reconcile=reconcile,
)


def register(ctx):
    ctx.register_middleware("tool_execution", once_tool_execution)
```

With the placeholder reconciliation above, an ambiguous execution remains
`UNKNOWN` and is blocked. A real integration must provide exact provider truth
before claiming recovery.

## Scope

This is an Once-side compatibility and adversarial proof against the documented
Hermes middleware failure policy. It is not an upstream Hermes patch and does
not assert that Hermes maintainers endorse Once.

The pinned upstream middleware proof now passes. The next stronger evidence is
one disposable real external provider mutation driven through this exact path,
with the provider committing, acknowledgement deliberately lost, process state
recreated, and read-only provider reconciliation recovering the original result
while the provider shows exactly one external effect.

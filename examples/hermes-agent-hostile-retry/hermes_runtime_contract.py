from __future__ import annotations

import json
import sys
import tempfile
import types
from pathlib import Path

from once_agent.core import OnceCore, OperationState, ProviderTruth
from once_agent.hermes import HermesLookupResult, make_hermes_tool_execution_middleware
from once_agent.storage.sqlite import SQLiteOperationStore


EXPECTED_HERMES_COMMIT = "ea81748579ee1732d214ccb75f91d22208ed623d"


class _Manager:
    def __init__(self) -> None:
        self._middleware = {}
        self.failures = []

    def _report_hook_failure(self, kind, callback, call_kwargs, exc, *, surface):
        del call_kwargs
        self.failures.append(
            {
                "kind": kind,
                "callback": getattr(callback, "__name__", repr(callback)),
                "error": type(exc).__name__,
                "surface": surface,
            }
        )


class ExternalLedger:
    """Deliberately non-idempotent external side effect plus read-only lookup."""

    def __init__(self) -> None:
        self.effects = []
        self.lose_ack_next = False
        self.lookup_mode = "confirmed"

    def terminal(self, args):
        receipt = {
            "effect_id": f"effect_{len(self.effects) + 1}",
            "intent_id": args["intent_id"],
            "amount": args["amount"],
        }
        self.effects.append({"args": dict(args), "receipt": dict(receipt)})
        if self.lose_ack_next:
            self.lose_ack_next = False
            raise RuntimeError("simulated acknowledgement loss after external commit")
        return receipt

    def reconcile(self, operation_id, action_fingerprint, args, context):
        del operation_id, action_fingerprint, context
        if self.lookup_mode == "unknown":
            return HermesLookupResult(ProviderTruth.UNKNOWN)
        matches = [
            row
            for row in self.effects
            if row["args"]["intent_id"] == args["intent_id"]
            and row["args"]["amount"] == args["amount"]
        ]
        if len(matches) == 1:
            return HermesLookupResult(
                ProviderTruth.CONFIRMED,
                dict(matches[0]["receipt"]),
            )
        return HermesLookupResult(ProviderTruth.UNKNOWN)


def operation_id(tool_name, args, context):
    del context
    if tool_name != "charge":
        return None
    return f"charge:{args['intent_id']}"


def block_code(value):
    parsed = json.loads(value)
    assert parsed["ok"] is False
    return parsed["code"]


def load_pinned_hermes(checkout: Path):
    git_head = (checkout / ".git" / "HEAD")
    if not git_head.exists():
        raise AssertionError("Hermes checkout has no .git/HEAD; expected actions/checkout clone")

    # Import the real pinned Hermes middleware module. Its execution path imports
    # hermes_cli.plugins lazily; replace only that manager surface so this proof
    # exercises the exact upstream _run_execution_chain implementation without
    # installing or executing the rest of Hermes' large dependency graph.
    sys.path.insert(0, str(checkout))
    import hermes_cli.middleware as hermes_middleware  # type: ignore

    manager = _Manager()
    plugins_stub = types.ModuleType("hermes_cli.plugins")
    plugins_stub._delivery_manager = lambda: manager
    sys.modules["hermes_cli.plugins"] = plugins_stub
    return hermes_middleware, manager


def invoke(hermes_middleware, manager, callback, terminal, *, tool_name, args, **context):
    manager._middleware = {"tool_execution": [callback]}
    return hermes_middleware.run_tool_execution_middleware(
        tool_name,
        dict(args),
        terminal,
        original_args=dict(args),
        **context,
    )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: hermes_runtime_contract.py PATH_TO_PINNED_HERMES_CHECKOUT")

    checkout = Path(sys.argv[1]).resolve()
    hermes_middleware, manager = load_pinned_hermes(checkout)

    # 1. Prove the upstream fail-open behavior directly, not via a local model.
    control_calls = {"count": 0}

    def control_terminal(args):
        control_calls["count"] += 1
        return {"ok": True, "args": dict(args)}

    def broken_middleware(**kwargs):
        del kwargs
        raise RuntimeError("pre-dispatch middleware failure")

    control = invoke(
        hermes_middleware,
        manager,
        broken_middleware,
        control_terminal,
        tool_name="charge",
        args={"intent_id": "control", "amount": 1},
    )
    assert control["ok"] is True
    assert control_calls["count"] == 1
    assert manager.failures, "expected upstream Hermes to report middleware failure"

    # 2. Prove a Once pre-dispatch failure does not fall through to the base tool.
    class FailingStore:
        def acquire_or_observe(self, **kwargs):
            del kwargs
            raise RuntimeError("simulated Once state-store failure")

    blocked_calls = {"count": 0}

    def blocked_terminal(args):
        blocked_calls["count"] += 1
        return {"unexpected": dict(args)}

    blocked_middleware = make_hermes_tool_execution_middleware(
        core=OnceCore(FailingStore(), lease_ms=60_000),
        operation_id=operation_id,
    )
    blocked = invoke(
        hermes_middleware,
        manager,
        blocked_middleware,
        blocked_terminal,
        tool_name="charge",
        args={"intent_id": "store-failure", "amount": 5},
    )
    assert block_code(blocked) == "once_safety_blocked"
    assert blocked_calls["count"] == 0

    # 3. Execute, replay with a different transport/tool-call ID, then reject drift.
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "once.sqlite"
        ledger = ExternalLedger()
        core = OnceCore(SQLiteOperationStore(path), lease_ms=60_000)
        middleware = make_hermes_tool_execution_middleware(
            core=core,
            operation_id=operation_id,
            reconcile=ledger.reconcile,
        )
        args = {"intent_id": "stable", "amount": 42}

        first = invoke(
            hermes_middleware,
            manager,
            middleware,
            ledger.terminal,
            tool_name="charge",
            args=args,
            session_id="session-1",
            task_id="task-1",
            turn_id="turn-1",
            tool_call_id="transport-call-1",
        )
        assert first["effect_id"] == "effect_1"
        assert len(ledger.effects) == 1

        replay = invoke(
            hermes_middleware,
            manager,
            middleware,
            ledger.terminal,
            tool_name="charge",
            args=args,
            session_id="session-1",
            task_id="task-1",
            turn_id="turn-2",
            tool_call_id="different-transport-call-id",
        )
        assert replay == first
        assert len(ledger.effects) == 1

        conflict = invoke(
            hermes_middleware,
            manager,
            middleware,
            ledger.terminal,
            tool_name="charge",
            args={"intent_id": "stable", "amount": 84},
            session_id="session-1",
            task_id="task-1",
            turn_id="turn-3",
            tool_call_id="transport-call-3",
        )
        assert block_code(conflict) == "once_operation_conflict"
        assert len(ledger.effects) == 1

    # 4. Real upstream middleware path: external commit, lost ack, UNKNOWN,
    # fresh OnceCore with durable state, provider reconciliation, still one effect.
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "once.sqlite"
        ledger = ExternalLedger()
        ledger.lose_ack_next = True
        args = {"intent_id": "lost-ack", "amount": 99}

        core1 = OnceCore(SQLiteOperationStore(path), lease_ms=60_000)
        middleware1 = make_hermes_tool_execution_middleware(
            core=core1,
            operation_id=operation_id,
            reconcile=ledger.reconcile,
        )
        unknown = invoke(
            hermes_middleware,
            manager,
            middleware1,
            ledger.terminal,
            tool_name="charge",
            args=args,
            session_id="session-2",
            task_id="task-lost-ack",
            turn_id="turn-1",
            tool_call_id="before-restart",
        )
        assert block_code(unknown) == "once_outcome_unknown"
        assert len(ledger.effects) == 1
        assert SQLiteOperationStore(path).get("charge:lost-ack").state == OperationState.UNKNOWN

        ledger.lookup_mode = "unknown"
        still_unknown = invoke(
            hermes_middleware,
            manager,
            middleware1,
            ledger.terminal,
            tool_name="charge",
            args=args,
            session_id="session-2",
            task_id="task-lost-ack",
            turn_id="turn-2",
            tool_call_id="while-unknown",
        )
        assert block_code(still_unknown) == "once_outcome_unknown"
        assert len(ledger.effects) == 1

        ledger.lookup_mode = "confirmed"
        core2 = OnceCore(SQLiteOperationStore(path), lease_ms=60_000)
        middleware2 = make_hermes_tool_execution_middleware(
            core=core2,
            operation_id=operation_id,
            reconcile=ledger.reconcile,
        )
        recovered = invoke(
            hermes_middleware,
            manager,
            middleware2,
            ledger.terminal,
            tool_name="charge",
            args=args,
            session_id="session-2",
            task_id="task-lost-ack",
            turn_id="turn-3",
            tool_call_id="after-restart",
        )
        assert recovered["effect_id"] == "effect_1"
        assert len(ledger.effects) == 1
        assert SQLiteOperationStore(path).get("charge:lost-ack").state == OperationState.CONFIRMED

    print("PASS: Once adapter held through pinned Hermes run_tool_execution_middleware")
    print(f"HERMES_PIN={EXPECTED_HERMES_COMMIT}")
    print("CONTROL fail-open -> base tool executed once")
    print("ONCE pre-dispatch failure -> base tool executed zero times")
    print("REPLAY same logical action -> one effect total")
    print("CONFLICT semantic drift -> no second effect")
    print("LOST_ACK -> UNKNOWN -> restart/reconcile -> one effect total")


if __name__ == "__main__":
    main()

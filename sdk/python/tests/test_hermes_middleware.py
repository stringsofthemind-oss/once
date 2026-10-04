from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from once_agent.core import OnceCore, OperationState, ProviderTruth
from once_agent.hermes import HermesLookupResult, make_hermes_tool_execution_middleware
from once_agent.storage.sqlite import SQLiteOperationStore


class _DownstreamExecutionError(Exception):
    def __init__(self, original):
        super().__init__(str(original))
        self.original = original


def run_hermes_fail_open_frame(callback, terminal_call, *, tool_name, args, **context):
    """One-callback model of Hermes' current _run_execution_chain semantics."""
    next_called = False
    next_succeeded = False
    next_result = None

    def next_call(next_payload=None):
        nonlocal next_called, next_succeeded, next_result
        if next_called:
            raise RuntimeError("next_call() is single-use")
        next_called = True
        try:
            next_result = terminal_call(args if next_payload is None else next_payload)
            next_succeeded = True
            return next_result
        except Exception as exc:
            raise _DownstreamExecutionError(exc) from exc

    try:
        return callback(
            tool_name=tool_name,
            args=dict(args),
            original_args=dict(args),
            next_call=next_call,
            telemetry_schema_version="hermes.observer.v1",
            middleware_schema_version="hermes.middleware.v1",
            **context,
        )
    except _DownstreamExecutionError as exc:
        raise exc.original
    except Exception:
        if next_succeeded:
            return next_result
        if next_called:
            raise
        return terminal_call(dict(args))


class ExternalLedger:
    """Deliberately non-idempotent external effect with read-only lookup."""

    def __init__(self):
        self.effects = []
        self.lose_ack_next = False
        self.lookup_mode = "confirmed"

    def terminal(self, args):
        receipt = {
            "effect_id": "effect_%d" % (len(self.effects) + 1),
            "intent_id": args["intent_id"],
            "amount": args["amount"],
        }
        self.effects.append({"args": dict(args), "receipt": dict(receipt)})
        if self.lose_ack_next:
            self.lose_ack_next = False
            raise RuntimeError("simulated acknowledgement loss after commit")
        return receipt

    def reconcile(self, operation_id, action_fingerprint, args, context):
        del operation_id, action_fingerprint, context
        if self.lookup_mode == "unknown":
            return HermesLookupResult(ProviderTruth.UNKNOWN)
        if self.lookup_mode == "absent":
            return HermesLookupResult(ProviderTruth.ABSENT)

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
    return "charge:%s" % args["intent_id"]


def block_code(value):
    parsed = json.loads(value)
    if parsed.get("ok") is not False:
        raise AssertionError("expected Once blocked-result payload")
    return parsed["code"]


class HermesMiddlewareSafetyTests(unittest.TestCase):
    def test_control_proves_hermes_fail_open_pre_next_call(self):
        calls = {"count": 0}

        def terminal(args):
            calls["count"] += 1
            return {"ok": True, "args": dict(args)}

        def broken_middleware(**kwargs):
            del kwargs
            raise RuntimeError("middleware failed before dispatch")

        run_hermes_fail_open_frame(
            broken_middleware,
            terminal,
            tool_name="charge",
            args={"intent_id": "control", "amount": 1},
        )
        self.assertEqual(calls["count"], 1)

    def test_execute_replay_and_semantic_conflict(self):
        with tempfile.TemporaryDirectory() as td:
            core = OnceCore(
                SQLiteOperationStore(Path(td) / "once.sqlite"),
                lease_ms=60_000,
            )
            ledger = ExternalLedger()
            middleware = make_hermes_tool_execution_middleware(
                core=core,
                operation_id=operation_id,
                reconcile=ledger.reconcile,
            )
            args = {"intent_id": "A", "amount": 42}

            first = run_hermes_fail_open_frame(
                middleware,
                ledger.terminal,
                tool_name="charge",
                args=args,
                session_id="s1",
                task_id="task-1",
                turn_id="turn-1",
                tool_call_id="transport-call-1",
            )
            self.assertEqual(first["effect_id"], "effect_1")
            self.assertEqual(len(ledger.effects), 1)

            replay = run_hermes_fail_open_frame(
                middleware,
                ledger.terminal,
                tool_name="charge",
                args=args,
                session_id="s1",
                task_id="task-1",
                turn_id="turn-2",
                tool_call_id="different-transport-call-id",
            )
            self.assertEqual(replay, first)
            self.assertEqual(len(ledger.effects), 1)

            conflict = run_hermes_fail_open_frame(
                middleware,
                ledger.terminal,
                tool_name="charge",
                args={"intent_id": "A", "amount": 84},
                session_id="s1",
                task_id="task-1",
                turn_id="turn-3",
                tool_call_id="transport-call-3",
            )
            self.assertEqual(block_code(conflict), "once_operation_conflict")
            self.assertEqual(len(ledger.effects), 1)

    def test_lost_ack_unknown_restart_reconciliation_stays_one_effect(self):
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
            first = run_hermes_fail_open_frame(
                middleware1,
                ledger.terminal,
                tool_name="charge",
                args=args,
                session_id="s2",
                task_id="task-lost-ack",
                turn_id="turn-1",
                tool_call_id="call-before-restart",
            )
            self.assertEqual(block_code(first), "once_outcome_unknown")
            self.assertEqual(len(ledger.effects), 1)
            self.assertEqual(
                SQLiteOperationStore(path).get("charge:lost-ack").state,
                OperationState.UNKNOWN,
            )

            ledger.lookup_mode = "unknown"
            still_unknown = run_hermes_fail_open_frame(
                middleware1,
                ledger.terminal,
                tool_name="charge",
                args=args,
                session_id="s2",
                task_id="task-lost-ack",
                turn_id="turn-2",
                tool_call_id="call-while-unknown",
            )
            self.assertEqual(block_code(still_unknown), "once_outcome_unknown")
            self.assertEqual(len(ledger.effects), 1)

            ledger.lookup_mode = "confirmed"
            core2 = OnceCore(SQLiteOperationStore(path), lease_ms=60_000)
            middleware2 = make_hermes_tool_execution_middleware(
                core=core2,
                operation_id=operation_id,
                reconcile=ledger.reconcile,
            )
            recovered = run_hermes_fail_open_frame(
                middleware2,
                ledger.terminal,
                tool_name="charge",
                args=args,
                session_id="s2",
                task_id="task-lost-ack",
                turn_id="turn-3",
                tool_call_id="call-after-restart",
            )
            self.assertEqual(recovered["effect_id"], "effect_1")
            self.assertEqual(len(ledger.effects), 1)
            self.assertEqual(
                SQLiteOperationStore(path).get("charge:lost-ack").state,
                OperationState.CONFIRMED,
            )

    def test_authoritative_absence_does_not_authorize_opaque_redispatch(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "once.sqlite"
            ledger = ExternalLedger()
            ledger.lose_ack_next = True
            core = OnceCore(SQLiteOperationStore(path), lease_ms=60_000)
            middleware = make_hermes_tool_execution_middleware(
                core=core,
                operation_id=operation_id,
                reconcile=ledger.reconcile,
            )
            args = {"intent_id": "absence", "amount": 7}

            first = run_hermes_fail_open_frame(
                middleware,
                ledger.terminal,
                tool_name="charge",
                args=args,
            )
            self.assertEqual(block_code(first), "once_outcome_unknown")
            self.assertEqual(len(ledger.effects), 1)

            ledger.effects.clear()
            ledger.lookup_mode = "absent"
            blocked = run_hermes_fail_open_frame(
                middleware,
                ledger.terminal,
                tool_name="charge",
                args=args,
            )
            self.assertEqual(block_code(blocked), "once_unsafe_redispatch_blocked")
            self.assertEqual(len(ledger.effects), 0)

    def test_store_failure_before_next_call_is_normal_block_not_fail_open(self):
        class FailingStore:
            def acquire_or_observe(self, **kwargs):
                del kwargs
                raise RuntimeError("simulated Once state-store failure")

        calls = {"count": 0}

        def terminal(args):
            calls["count"] += 1
            return {"unexpected": dict(args)}

        middleware = make_hermes_tool_execution_middleware(
            core=OnceCore(FailingStore(), lease_ms=60_000),
            operation_id=operation_id,
        )
        blocked = run_hermes_fail_open_frame(
            middleware,
            terminal,
            tool_name="charge",
            args={"intent_id": "store-failure", "amount": 5},
        )
        self.assertEqual(block_code(blocked), "once_safety_blocked")
        self.assertEqual(calls["count"], 0)

    def test_identity_resolver_failure_before_next_call_is_fail_closed(self):
        class FailingStore:
            def acquire_or_observe(self, **kwargs):
                del kwargs
                raise AssertionError("store should not be reached")

        calls = {"count": 0}

        def resolver_failure(tool_name, args, context):
            del tool_name, args, context
            raise RuntimeError("identity service unavailable")

        def terminal(args):
            calls["count"] += 1
            return dict(args)

        middleware = make_hermes_tool_execution_middleware(
            core=OnceCore(FailingStore(), lease_ms=60_000),
            operation_id=resolver_failure,
        )
        blocked = run_hermes_fail_open_frame(
            middleware,
            terminal,
            tool_name="charge",
            args={"intent_id": "identity-failure", "amount": 5},
        )
        self.assertEqual(block_code(blocked), "once_safety_blocked")
        self.assertEqual(calls["count"], 0)

    def test_non_json_protected_args_fail_closed_before_next_call(self):
        class UnusedStore:
            def acquire_or_observe(self, **kwargs):
                del kwargs
                raise AssertionError("store should not be reached after fingerprint failure")

        calls = {"count": 0}

        def resolver(tool_name, args, context):
            del context
            if tool_name != "charge":
                return None
            return "charge:non-json"

        def terminal(args):
            calls["count"] += 1
            return {"unexpected": repr(args)}

        middleware = make_hermes_tool_execution_middleware(
            core=OnceCore(UnusedStore(), lease_ms=60_000),
            operation_id=resolver,
        )
        blocked = run_hermes_fail_open_frame(
            middleware,
            terminal,
            tool_name="charge",
            args={"intent_id": "non-json", "amount": {1, 2, 3}},
        )
        self.assertEqual(block_code(blocked), "once_safety_blocked")
        self.assertEqual(calls["count"], 0)

    def test_broken_blocked_result_formatter_cannot_reopen_fail_open_path(self):
        class FailingStore:
            def acquire_or_observe(self, **kwargs):
                del kwargs
                raise RuntimeError("simulated Once state-store failure")

        calls = {"count": 0}

        def terminal(args):
            calls["count"] += 1
            return {"unexpected": dict(args)}

        def broken_blocked_result(tool_name, exc):
            del tool_name, exc
            raise RuntimeError("custom formatter failed")

        middleware = make_hermes_tool_execution_middleware(
            core=OnceCore(FailingStore(), lease_ms=60_000),
            operation_id=operation_id,
            blocked_result=broken_blocked_result,
        )
        blocked = run_hermes_fail_open_frame(
            middleware,
            terminal,
            tool_name="charge",
            args={"intent_id": "formatter-failure", "amount": 5},
        )
        self.assertEqual(block_code(blocked), "once_safety_blocked")
        self.assertEqual(calls["count"], 0)

    def test_explicit_bypass_preserves_normal_hermes_tool_execution(self):
        class UnusedStore:
            def acquire_or_observe(self, **kwargs):
                del kwargs
                raise AssertionError("Once should not be reached for bypassed tools")

        calls = {"count": 0}

        def terminal(args):
            calls["count"] += 1
            return {"rows": [dict(args)]}

        middleware = make_hermes_tool_execution_middleware(
            core=OnceCore(UnusedStore(), lease_ms=60_000),
            operation_id=operation_id,
        )
        result = run_hermes_fail_open_frame(
            middleware,
            terminal,
            tool_name="read_status",
            args={"query": "safe read"},
        )
        self.assertEqual(calls["count"], 1)
        self.assertEqual(result["rows"][0]["query"], "safe read")


if __name__ == "__main__":
    unittest.main(verbosity=2)

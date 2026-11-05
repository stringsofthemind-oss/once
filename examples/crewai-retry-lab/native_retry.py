"""Offline #5802 regression: real CrewAI task retry, simulated payment authority.

Run with an installed once-agent-sdk; this module never inserts repository SDK
source into sys.path. The scripted LLM is the only replacement for CrewAI code.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import importlib.metadata as metadata
import json
import multiprocessing as mp
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

# Set before importing CrewAI; no model or telemetry service is needed.
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["CREWAI_TELEMETRY_DISABLED"] = "true"
os.environ["CREWAI_TRACING_ENABLED"] = "false"

from crewai import Agent, Task
from crewai.llms.base_llm import BaseLLM
from crewai.tools import BaseTool, ToolFailure
from pydantic import PrivateAttr

import once_agent.core as core_module
from once_agent.core import (
    AmbiguousProviderOutcome, ConcurrentModification, ExecutionSource,
    OnceCore, OperationConflict, OperationInFlight, OperationRequest,
    OperationState, ProviderCapabilities, ProviderObservation, ProviderTruth,
    UnresolvedOutcome, UnsafeProviderCapability, fingerprint_action,
)
from once_agent.storage.sqlite import SQLiteOperationStore

ACTION = dict(payer="sandbox-account-A", recipient="merchant-7",
              amount_cents=5000, currency="GBP")
INTENT = "payment:admitted-intent-A"


def request(operation_id=INTENT, action=None):
    action = dict(ACTION if action is None else action)
    return OperationRequest(operation_id, fingerprint_action("payment", action), action)


class PaymentAuthority:
    """Separate durable effect ledger; intentionally NO execution deduplication.

    Local simulation, not a network provider. Every execute adds a row. Lookup
    is authoritative only for this fixture and verifies the bound fingerprint.
    """
    capabilities = ProviderCapabilities(lookup_by_operation_id=True,
                                        authoritative_absence=True)

    def __init__(self, path, *, lose_ack=False, crash=False, entered=None, finish=None):
        self.path = Path(path)
        self.lose_ack, self.crash = lose_ack, crash
        self.entered, self.finish = entered, finish
        self.truth_available = True
        with closing(self.connect()) as db:
            db.execute("CREATE TABLE IF NOT EXISTS effects (id INTEGER PRIMARY KEY, "
                       "operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, action TEXT NOT NULL)")

    def connect(self):
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=FULL")
        return db

    def execute(self, *, operation_id, action_fingerprint, action, fence_token):
        with closing(self.connect()) as db:
            row = db.execute("INSERT INTO effects(operation_id,fingerprint,action) VALUES(?,?,?)",
                             (operation_id, action_fingerprint, json.dumps(action, sort_keys=True)))
            receipt = dict(effect_id=row.lastrowid, operation_id=operation_id,
                           action_fingerprint=action_fingerprint, action=action)
        # At every injection point the separate provider transaction has committed.
        if self.entered is not None:
            self.entered.set()
            if not self.finish.wait(45):
                raise RuntimeError("test coordinator never released provider response")
        if self.crash:
            os._exit(77)
        if self.lose_ack:
            self.lose_ack = False
            raise AmbiguousProviderOutcome("payment committed; response deliberately lost")
        return receipt

    def lookup(self, *, operation_id, action_fingerprint):
        if not self.truth_available:
            return ProviderObservation(ProviderTruth.UNKNOWN)
        with closing(self.connect()) as db:
            rows = db.execute("SELECT id,fingerprint,action FROM effects WHERE operation_id=?",
                              (operation_id,)).fetchall()
        if not rows:
            return ProviderObservation(ProviderTruth.ABSENT)
        if len(rows) != 1 or rows[0][1] != action_fingerprint:
            return ProviderObservation(ProviderTruth.UNKNOWN)
        return ProviderObservation(ProviderTruth.CONFIRMED, dict(
            effect_id=rows[0][0], operation_id=operation_id,
            action_fingerprint=rows[0][1], action=json.loads(rows[0][2])))

    def count(self):
        with closing(self.connect()) as db:
            return db.execute("SELECT count(*) FROM effects").fetchone()[0]


class PaymentTool(BaseTool):
    name: str = "send_payment"
    description: str = "Execute the already admitted synthetic payment intent."
    _provider: object = PrivateAttr()
    _core: object = PrivateAttr()
    _calls: list = PrivateAttr(default_factory=list)
    _crash_after_confirm: bool = PrivateAttr(default=False)

    def __init__(self, provider, core=None, crash_after_confirm=False):
        super().__init__()
        self._provider, self._core = provider, core
        self._crash_after_confirm = crash_after_confirm

    def _run(self, operation_id: str, payer: str, recipient: str,
             amount_cents: int, currency: str):
        req = request(operation_id, dict(payer=payer, recipient=recipient,
                                        amount_cents=amount_cents, currency=currency))
        self._calls.append(operation_id)
        try:
            if self._core is not None:
                result = self._core.execute(req, provider=self._provider)
                if self._crash_after_confirm:
                    os._exit(79)
                return json.dumps(dict(receipt=result.receipt, source=result.source.value))
            return json.dumps(dict(receipt=self._provider.execute(
                operation_id=req.operation_id, action_fingerprint=req.action_fingerprint,
                action=req.action, fence_token=0), source="UNPROTECTED"))
        except (AmbiguousProviderOutcome, UnresolvedOutcome):
            return ToolFailure(message="Outcome unknown; no receipt available.",
                               code="once_outcome_unknown", retryable=False)
        except OperationConflict:
            return ToolFailure(message="Intent reused with changed payment fields.",
                               code="once_operation_conflict", retryable=False)


class ScriptedLLM(BaseLLM):
    """Deterministic ReAct transcript; does not implement a retry loop."""
    def __init__(self):
        super().__init__(model="offline-scripted")
        self.calls = 0
        self.observations = []

    def supports_function_calling(self):
        return False

    def call(self, messages, **kwargs):
        self.calls += 1
        if self.calls in (1, 3):
            return ("Thought: Execute the admitted intent.\nAction: send_payment\n"
                    "Action Input: " + json.dumps(dict(operation_id=INTENT, **ACTION)))
        self.observations.append(json.dumps(messages, default=str))
        if self.calls == 2:
            # Tool has already reported uncertain outcome. The executor failure
            # here propagates to Agent.execute_task's max_retry_limit handling.
            raise RuntimeError("injected executor failure after lost payment acknowledgement")
        if self.calls == 4:
            return "Final Answer: Script finished; inspect the actual receipt and provider ledger."
        raise AssertionError(f"unexpected model call {self.calls}")


def run_native(root, protected):
    provider = PaymentAuthority(root / "provider.db", lose_ack=True)
    store = SQLiteOperationStore(root / "once.db") if protected else None
    tool = PaymentTool(provider, OnceCore(store) if protected else None)
    llm = ScriptedLLM()
    agent = Agent(role="Payment test", goal="Execute one admitted payment",
                  backstory="Offline deterministic regression", llm=llm,
                  tools=[tool], max_retry_limit=1, max_iter=5, cache=False,
                  allow_delegation=False, verbose=False)
    task = Task(description="Execute admitted payment intent A.",
                expected_output="Payment receipt or explicit unknown outcome", agent=agent)
    # Exactly one application invocation. CrewAI owns the recursive retry.
    agent.execute_task(task)
    assert llm.calls == 4, llm.calls
    assert agent._times_executed == 1, agent._times_executed
    assert tool._calls == [INTENT, INTENT], tool._calls
    assert provider.count() == (1 if protected else 2), provider.count()
    first_observation = str(llm.observations[0])
    second_observation = str(llm.observations[1])
    assert "unknown" in first_observation.lower(), first_observation
    assert "receipt" in second_observation, second_observation
    if protected:
        assert store.get(INTENT).state == OperationState.CONFIRMED
        assert "RECONCILED" in second_observation, second_observation
    return dict(effects=provider.count(), tool_calls=len(tool._calls),
                native_task_retries=agent._times_executed, llm_calls=llm.calls)


def worker(root, protected, crash, result_path, ready=None, start=None,
           entered=None, finish=None, clock_offset_ms=0, crash_after_confirm=False):
    """Spawn-safe process entry; actual native structured-tool invocation."""
    root = Path(root)
    provider = PaymentAuthority(root / "provider.db", crash=crash,
                                entered=entered, finish=finish)
    store = SQLiteOperationStore(root / "once.db", now_ms=lambda:
        time.time_ns() // 1_000_000 + clock_offset_ms) if protected else None
    core = OnceCore(store, lease_ms=120_000) if protected else None
    tool = PaymentTool(provider, core, crash_after_confirm)
    if ready is not None:
        ready.set()
        if not start.wait(45):
            raise RuntimeError("start barrier timed out")
    try:
        result = tool.to_structured_tool().invoke(dict(operation_id=INTENT, **ACTION))
        outcome = dict(status="returned", result=result, pid=os.getpid())
    except OperationInFlight:
        outcome = dict(status="in_flight", pid=os.getpid())
    Path(result_path).write_text(json.dumps(outcome), encoding="utf-8")


class RetryTests(unittest.TestCase):
    results = {}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="once-crewai-5802-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.provider = PaymentAuthority(self.root / "provider.db")
        self.clock = [1000]
        self.store = SQLiteOperationStore(self.root / "once.db", now_ms=lambda: self.clock[0])
        self.core = OnceCore(self.store, lease_ms=100)

    def test_native_task_retry_control(self):
        self.results["native_control"] = run_native(self.root, False)

    def test_native_task_retry_once(self):
        self.results["native_once"] = run_native(self.root, True)

    def test_lost_response_unknown_then_authoritative_recovery(self):
        self.provider.lose_ack = True
        with self.assertRaises(UnresolvedOutcome):
            self.core.execute(request(), provider=self.provider)
        self.assertEqual(self.store.get(INTENT).state, OperationState.UNKNOWN)
        self.provider.truth_available = False
        for _ in range(3):
            with self.assertRaises(UnresolvedOutcome):
                self.core.execute(request(), provider=self.provider)
        self.assertEqual(self.provider.count(), 1)
        self.provider.truth_available = True
        recovered = self.core.execute(request(), provider=self.provider)
        replay = self.core.execute(request(), provider=self.provider)
        self.assertEqual(recovered.source, ExecutionSource.RECONCILED)
        self.assertEqual(replay.source, ExecutionSource.REPLAYED)
        self.assertEqual(recovered.receipt, replay.receipt)
        self.assertEqual(self.provider.count(), 1)
        self.results["lost_response"] = dict(blocked_retries=3, effects=1,
                                               recovery="RECONCILED", replay="REPLAYED")

    def test_mutated_fields_conflict_in_all_record_states(self):
        mutations = dict(payer="other-account", recipient="other-merchant",
                         amount_cents=5001, currency="USD")
        for state in (OperationState.CLAIMED, OperationState.UNKNOWN, OperationState.CONFIRMED):
            op = "mutation:" + state.value
            req = request(op)
            if state == OperationState.CLAIMED:
                self.store.acquire_or_observe(operation_id=op, action_fingerprint=req.action_fingerprint,
                                              owner_token="held", lease_ms=100)
            elif state == OperationState.UNKNOWN:
                self.provider.lose_ack = True
                with self.assertRaises(UnresolvedOutcome):
                    self.core.execute(req, provider=self.provider)
            else:
                self.core.execute(req, provider=self.provider)
            before = self.provider.count()
            record = self.store.get(op)
            for field, value in mutations.items():
                with self.subTest(state=state, field=field):
                    with self.assertRaises(OperationConflict):
                        self.core.execute(request(op, {**ACTION, field: value}), provider=self.provider)
                    self.assertEqual(self.provider.count(), before)
                    self.assertEqual(self.store.get(op), record)
        self.results["mutations"] = dict(conflicts=12, additional_effects=0)

    def test_identical_payload_distinct_intents(self):
        a = self.core.execute(request(), provider=self.provider)
        b = self.core.execute(request("payment:admitted-intent-B"), provider=self.provider)
        self.assertNotEqual(a.receipt["effect_id"], b.receipt["effect_id"])
        self.assertEqual(self.core.execute(request(), provider=self.provider).receipt, a.receipt)
        self.assertEqual(self.provider.count(), 2)
        self.results["distinct_intents"] = dict(effects=2)

    def test_confirmed_record_cannot_be_released_by_recovery(self):
        first = self.core.execute(request(), provider=self.provider)
        record = self.store.get(INTENT)
        # No release/delete/reset API exists in this Python core. Test the real
        # recovery transitions, including current and stale optimistic versions.
        self.clock[0] += 1_000_000
        for version in (record.version, record.version - 1):
            with self.assertRaises(ConcurrentModification):
                self.store.reacquire_after_absent(operation_id=INTENT,
                    action_fingerprint=record.action_fingerprint, expected_version=version,
                    owner_token="new-holder", lease_ms=100)
            with self.assertRaises(ConcurrentModification):
                self.store.mark_unknown(operation_id=INTENT,
                    action_fingerprint=record.action_fingerprint, expected_version=version)
            self.assertEqual(self.store.get(INTENT), record)
        replay = self.core.execute(request(), provider=self.provider)
        self.assertEqual(replay.receipt, first.receipt)
        self.assertEqual(self.provider.count(), 1)
        self.results["confirmed_release"] = dict(refused_transitions=4, effects=1)

    def test_expired_claim_without_effect_does_not_authorize_redispatch(self):
        req = request()
        self.store.acquire_or_observe(operation_id=INTENT, action_fingerprint=req.action_fingerprint,
                                      owner_token="dead-before-dispatch", lease_ms=100)
        self.clock[0] += 101
        with self.assertRaises(UnsafeProviderCapability):
            self.core.execute(req, provider=self.provider)
        self.assertEqual(self.provider.count(), 0)
        self.assertNotEqual(self.store.get(INTENT).state, OperationState.CONFIRMED)
        self.results["absent_nonidempotent"] = dict(effects=0, refused=True)

    def spawn(self, **kwargs):
        process = mp.get_context("spawn").Process(target=worker, kwargs=kwargs)
        process.start()
        self.addCleanup(self.stop, process)
        return process

    @staticmethod
    def stop(process):
        if process.is_alive():
            process.terminate()
        process.join(10)
        process.close()

    def test_concurrent_claims_count_external_dispatches(self):
        ctx = mp.get_context("spawn")
        entered, finish, start = ctx.Event(), ctx.Event(), ctx.Event()
        ready = [ctx.Event() for _ in range(8)]
        outputs = [self.root / f"worker-{i}.json" for i in range(8)]
        workers = [self.spawn(root=str(self.root), protected=True, crash=False,
                             result_path=str(outputs[i]), ready=ready[i], start=start,
                             entered=entered, finish=finish) for i in range(8)]
        try:
            self.assertTrue(all(event.wait(60) for event in ready), "workers not ready")
            start.set()
            self.assertTrue(entered.wait(30), "no provider dispatch")
            # Winner is held after committing. Every loser must finish while
            # the winner is still active, proving an actual overlapping claim.
            deadline = time.monotonic() + 45
            while sum(path.exists() for path in outputs) < 7 and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(sum(path.exists() for path in outputs), 7)
            self.assertEqual(self.provider.count(), 1)
        finally:
            finish.set()
            start.set()
        for process in workers:
            process.join(30)
            self.assertEqual(process.exitcode, 0)
        rows = [json.loads(path.read_text()) for path in outputs]
        self.assertEqual(sum(row["status"] == "in_flight" for row in rows), 7)
        self.assertEqual(len({row["pid"] for row in rows}), 8)
        self.assertEqual(self.provider.count(), 1)
        self.results["concurrency"] = dict(processes=8, in_flight=7, effects=1)

    def test_process_death_before_acknowledgement(self):
        for protected in (False, True):
            with self.subTest(protected=protected):
                root = self.root / str(protected)
                root.mkdir()
                provider = PaymentAuthority(root / "provider.db")
                output = root / "crashed.json"
                child = self.spawn(root=str(root), protected=protected, crash=True,
                                   result_path=str(output))
                child.join(60)
                self.assertEqual(child.exitcode, 77)
                self.assertFalse(output.exists(), "crashed worker returned an acknowledgement")
                self.assertEqual(provider.count(), 1)
                if protected:
                    # Advance only the test clock to expire the dead lease;
                    # do not delete records or authorize recovery via SQL.
                    retry_output = root / "reconciled.json"
                    child2 = self.spawn(root=str(root), protected=True, crash=False,
                        result_path=str(retry_output), clock_offset_ms=120_001)
                    child2.join(60)
                    self.assertEqual(child2.exitcode, 0)
                    result = json.loads(json.loads(retry_output.read_text())["result"])
                    self.assertEqual(result["source"], "RECONCILED")
                else:
                    child2 = self.spawn(root=str(root), protected=False, crash=False,
                                        result_path=str(root / "redispatched.json"))
                    child2.join(60)
                    self.assertEqual(child2.exitcode, 0)
                self.assertEqual(provider.count(), 1 if protected else 2)
        self.results["process_death"] = dict(control_effects=2, once_effects=1,
                                              exit_code=77, redispatch="harness-owned")

    def test_confirmed_result_lost_before_framework_receives_it(self):
        output = self.root / "lost-result.json"
        child = self.spawn(root=str(self.root), protected=True, crash=False,
                           result_path=str(output), crash_after_confirm=True)
        child.join(60)
        self.assertEqual(child.exitcode, 79)
        self.assertFalse(output.exists())
        record = self.store.get(INTENT)
        self.assertEqual(record.state, OperationState.CONFIRMED)
        replay_output = self.root / "replay.json"
        retry = self.spawn(root=str(self.root), protected=True, crash=False,
                           result_path=str(replay_output))
        retry.join(60)
        self.assertEqual(retry.exitcode, 0)
        result = json.loads(json.loads(replay_output.read_text())["result"])
        self.assertEqual(result["source"], "REPLAYED")
        self.assertEqual(result["receipt"], record.receipt)
        self.assertEqual(self.provider.count(), 1)
        self.results["confirmed_result_lost"] = dict(exit_code=79, effects=1, source="REPLAYED")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=Path("native-evidence.json"))
    args = parser.parse_args()
    origin = Path(core_module.__file__).resolve()
    expected = Path(metadata.distribution("once-agent-sdk").locate_file("once_agent/core.py")).resolve()
    if origin != expected:
        raise RuntimeError(f"Expected installed SDK at {expected}, imported {origin}")
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(RetryTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    evidence = dict(passed=result.wasSuccessful(), tests=result.testsRun,
                    failures=len(result.failures), errors=len(result.errors),
                    python=sys.version, crewai=metadata.version("crewai"),
                    once=metadata.version("once-agent-sdk"), once_core_origin=str(origin),
                    once_core_sha256=hashlib.sha256(origin.read_bytes()).hexdigest(),
                    harness_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                    cases=RetryTests.results)
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, indent=2))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())

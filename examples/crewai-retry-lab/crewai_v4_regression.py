from __future__ import annotations

"""
Once V4 CrewAI hostile-retry portability lab.

This experiment keeps the frozen Once V4 core unchanged and changes only the
framework adapter.

It exercises CrewAI's native tool conversion/invocation path:

    BaseTool subclass
        -> BaseTool.to_structured_tool()
        -> CrewStructuredTool.ainvoke()
        -> bound BaseTool._run()

Fresh-process redispatch is deliberately controlled by this harness rather
than by an LLM or external orchestrator. That keeps the experiment
deterministic while preserving the production failure boundary:

    external effect commits
        -> process dies via os._exit(77)
        -> same logical task is dispatched in a fresh process

Evidence matrix:

    CONTROL
        first process commits effect and dies
        fresh process re-dispatches same logical action
        expected: 2 external effects -> DUPLICATED

    ONCE RECONCILIATION
        first process persists CLAIMED, commits provider effect, dies
        fresh process re-dispatches same logical action
        Once reconciles provider truth
        expected: 1 external effect -> CONFIRMED

    ONCE UNKNOWN / RECOVERY
        provider truth unavailable on fresh dispatch
        Once returns domain UNKNOWN through CrewAI ToolFailure
        no second external write
        truth restored, later fresh dispatch reconciles
        expected: UNKNOWN -> CONFIRMED, still 1 external effect
"""

import argparse
import asyncio
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
from typing import Any, Mapping, Optional

# Make the local frozen Once Python SDK importable when the script is run from
# examples/crewai-retry-lab inside the repository.
SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[2]
SDK_SRC = REPO_ROOT / "sdk" / "python" / "src"
if str(SDK_SRC) not in sys.path:
    sys.path.insert(0, str(SDK_SRC))

from pydantic import PrivateAttr

from crewai.tools import BaseTool, ToolFailure

from once_agent.core import (
    ExecutionRightLost,
    ExecutionSource,
    OnceCore,
    OperationConflict,
    OperationInFlight,
    OperationRequest,
    OperationState,
    ProviderCapabilities,
    ProviderObservation,
    ProviderTruth,
    UnsafeProviderCapability,
    UnresolvedOutcome,
    fingerprint_action,
)
from once_agent.storage.sqlite import SQLiteOperationStore


CRASH_EXIT_CODE = 77
UNKNOWN_EXIT_CODE = 78
LEASE_MS = 150
LEASE_SETTLE_SECONDS = 0.35

ORDER_ID = "order_123"
AMOUNT_CENTS = 4200
RECIPIENT = "merchant_7"

ACTION = {
    "order_id": ORDER_ID,
    "amount_cents": AMOUNT_CENTS,
    "recipient": RECIPIENT,
}


def stable_operation_id(order_id: str) -> str:
    return f"charge:{order_id}"


def action_fingerprint(
    *,
    order_id: str = ORDER_ID,
    amount_cents: int = AMOUNT_CENTS,
    recipient: str = RECIPIENT,
) -> str:
    return fingerprint_action(
        "charge",
        {
            "order_id": order_id,
            "amount_cents": amount_cents,
            "recipient": recipient,
        },
    )


class ProviderLedger:
    """
    Independent simulated external system of record.

    Deliberately does NOT deduplicate execute() calls by operation_id.
    If Once allows a second protected write, the database will record it as a
    second external effect. This prevents provider idempotency from masking a
    failure in the Once protocol.

    The provider *does* support authoritative lookup by operation_id, which is
    what allows Once to reconcile after a lost acknowledgement/process death.
    """

    capabilities = ProviderCapabilities(
        idempotent_by_operation_id=False,
        lookup_by_operation_id=True,
        authoritative_absence=True,
        fencing=False,
    )

    def __init__(
        self,
        path: Path,
        *,
        crash_after_commit: bool = False,
        mode: str = "provider",
    ) -> None:
        self.path = Path(path)
        self.crash_after_commit = crash_after_commit
        self.mode = mode
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            self.path,
            timeout=30,
            isolation_level=None,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def _initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)

        with closing(self._connect()) as conn:
            # operation_id is intentionally NOT UNIQUE. This provider does not
            # provide idempotent execution; duplicate writes remain observable.
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS effects (
                    effect_id TEXT PRIMARY KEY,
                    operation_id TEXT NOT NULL,
                    action_fingerprint TEXT NOT NULL,
                    order_id TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL,
                    recipient TEXT NOT NULL,
                    fence_token INTEGER NOT NULL,
                    mode TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_effects_operation
                ON effects(operation_id, effect_id)
                """
            )

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS provider_events (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    operation_id TEXT,
                    detail TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS provider_control (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                    truth_available INTEGER NOT NULL
                )
                """
            )

            conn.execute(
                """
                INSERT OR IGNORE INTO provider_control(
                    singleton,
                    truth_available
                )
                VALUES (1, 1)
                """
            )

    @staticmethod
    def _log(
        conn: sqlite3.Connection,
        event_type: str,
        operation_id: Optional[str],
        detail: Optional[str] = None,
    ) -> None:
        conn.execute(
            """
            INSERT INTO provider_events(
                event_type,
                operation_id,
                detail
            )
            VALUES (?, ?, ?)
            """,
            (event_type, operation_id, detail),
        )

    def set_truth_available(self, available: bool) -> None:
        with closing(self._connect()) as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """
                UPDATE provider_control
                SET truth_available = ?
                WHERE singleton = 1
                """,
                (1 if available else 0,),
            )
            conn.execute("COMMIT")

    def _next_effect_id(self, conn: sqlite3.Connection) -> str:
        row = conn.execute(
            "SELECT COUNT(*) + 1 AS n FROM effects"
        ).fetchone()
        return f"charge_{int(row['n'])}"

    def _commit_effect(
        self,
        *,
        operation_id: str,
        fingerprint: str,
        order_id: str,
        amount_cents: int,
        recipient: str,
        fence_token: int,
        event_mode: str,
    ) -> dict[str, Any]:
        conn = self._connect()

        try:
            conn.execute("BEGIN IMMEDIATE")

            self._log(
                conn,
                "CHARGE_REQUEST",
                operation_id,
                (
                    f"mode={event_mode};"
                    f"order_id={order_id};"
                    f"amount_cents={amount_cents};"
                    f"recipient={recipient};"
                    f"fence_token={fence_token}"
                ),
            )

            effect_id = self._next_effect_id(conn)

            conn.execute(
                """
                INSERT INTO effects(
                    effect_id,
                    operation_id,
                    action_fingerprint,
                    order_id,
                    amount_cents,
                    recipient,
                    fence_token,
                    mode
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    effect_id,
                    operation_id,
                    fingerprint,
                    order_id,
                    amount_cents,
                    recipient,
                    fence_token,
                    event_mode,
                ),
            )

            self._log(
                conn,
                "EFFECT_COMMITTED",
                operation_id,
                effect_id,
            )

            conn.execute("COMMIT")

        except BaseException:
            try:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()

        receipt = {
            "operation_id": operation_id,
            "effect_id": effect_id,
            "order_id": order_id,
            "amount_cents": amount_cents,
            "recipient": recipient,
            "action_fingerprint": fingerprint,
            "fence_token": fence_token,
        }

        print(
            json.dumps(
                {
                    "phase": "provider_committed",
                    "mode": event_mode,
                    "operation_id": operation_id,
                    "effect_id": effect_id,
                    "fence_token": fence_token,
                }
            ),
            flush=True,
        )

        if self.crash_after_commit:
            print(
                json.dumps(
                    {
                        "phase": "hard_crash",
                        "mode": event_mode,
                        "operation_id": operation_id,
                        "effect_id": effect_id,
                        "exit_code": CRASH_EXIT_CODE,
                        "message": (
                            "external effect is durable; terminating before "
                            "CrewAI/Once can persist a successful tool result"
                        ),
                    }
                ),
                flush=True,
            )
            os._exit(CRASH_EXIT_CODE)

        return receipt

    def execute_naive(
        self,
        *,
        order_id: str,
        amount_cents: int,
        recipient: str,
    ) -> dict[str, Any]:
        operation_id = stable_operation_id(order_id)
        fingerprint = action_fingerprint(
            order_id=order_id,
            amount_cents=amount_cents,
            recipient=recipient,
        )

        return self._commit_effect(
            operation_id=operation_id,
            fingerprint=fingerprint,
            order_id=order_id,
            amount_cents=amount_cents,
            recipient=recipient,
            fence_token=0,
            event_mode="control",
        )

    def execute(
        self,
        *,
        operation_id: str,
        action_fingerprint: str,
        action: Any,
        fence_token: int,
    ) -> dict[str, Any]:
        if not isinstance(action, Mapping):
            raise TypeError("provider action must be a mapping")

        return self._commit_effect(
            operation_id=operation_id,
            fingerprint=action_fingerprint,
            order_id=str(action["order_id"]),
            amount_cents=int(action["amount_cents"]),
            recipient=str(action["recipient"]),
            fence_token=fence_token,
            event_mode=self.mode,
        )

    def lookup(
        self,
        *,
        operation_id: str,
        action_fingerprint: str,
    ) -> ProviderObservation:
        conn = self._connect()

        try:
            conn.execute("BEGIN IMMEDIATE")

            self._log(
                conn,
                "STATUS_QUERY",
                operation_id,
            )

            control = conn.execute(
                """
                SELECT truth_available
                FROM provider_control
                WHERE singleton = 1
                """
            ).fetchone()

            if control is None or int(control["truth_available"]) != 1:
                self._log(
                    conn,
                    "STATUS_UNKNOWN",
                    operation_id,
                    "provider truth unavailable",
                )
                conn.execute("COMMIT")
                return ProviderObservation(ProviderTruth.UNKNOWN)

            rows = conn.execute(
                """
                SELECT *
                FROM effects
                WHERE operation_id = ?
                ORDER BY effect_id
                """,
                (operation_id,),
            ).fetchall()

            if not rows:
                self._log(
                    conn,
                    "STATUS_ABSENT",
                    operation_id,
                    "no provider record",
                )
                conn.execute("COMMIT")
                return ProviderObservation(ProviderTruth.ABSENT)

            # A protected path should never have more than one matching effect.
            # If it does, preserve the evidence and fail loudly rather than hide
            # a duplicate behind a "confirmed" observation.
            matching = [
                row
                for row in rows
                if row["action_fingerprint"] == action_fingerprint
            ]

            if len(matching) != 1:
                self._log(
                    conn,
                    "STATUS_AMBIGUOUS_MULTIPLE",
                    operation_id,
                    f"matching_effects={len(matching)};total_effects={len(rows)}",
                )
                conn.execute("COMMIT")
                return ProviderObservation(ProviderTruth.UNKNOWN)

            row = matching[0]
            receipt = {
                "operation_id": row["operation_id"],
                "effect_id": row["effect_id"],
                "order_id": row["order_id"],
                "amount_cents": int(row["amount_cents"]),
                "recipient": row["recipient"],
                "action_fingerprint": row["action_fingerprint"],
                "fence_token": int(row["fence_token"]),
            }

            self._log(
                conn,
                "STATUS_CONFIRMED",
                operation_id,
                row["effect_id"],
            )
            conn.execute("COMMIT")

            return ProviderObservation(
                ProviderTruth.CONFIRMED,
                receipt=receipt,
            )

        except BaseException:
            try:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()

    def effect_count(self) -> int:
        with closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM effects"
            ).fetchone()
            return int(row["n"])

    def events(self) -> list[dict[str, Any]]:
        with closing(self._connect()) as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM provider_events
                ORDER BY event_id
                """
            ).fetchall()
            return [dict(row) for row in rows]


class NativeChargeTool(BaseTool):
    """Unshielded control tool."""

    name: str = "send_payment"
    description: str = (
        "Send one payment for an order. Used by the hostile-retry control."
    )

    _provider: ProviderLedger = PrivateAttr()

    def __init__(self, *, provider: ProviderLedger, **data: Any) -> None:
        super().__init__(**data)
        self._provider = provider

    def _run(
        self,
        order_id: str,
        amount_cents: int,
        recipient: str,
    ) -> dict[str, Any]:
        return self._provider.execute_naive(
            order_id=order_id,
            amount_cents=amount_cents,
            recipient=recipient,
        )


class OnceProtectedChargeTool(BaseTool):
    """CrewAI adapter around the frozen framework-neutral Once V4 core."""

    name: str = "send_payment"
    description: str = (
        "Send one payment for an order through the Once execution-safety gate."
    )

    _core: OnceCore = PrivateAttr()
    _provider: ProviderLedger = PrivateAttr()

    def __init__(
        self,
        *,
        core: OnceCore,
        provider: ProviderLedger,
        **data: Any,
    ) -> None:
        super().__init__(**data)
        self._core = core
        self._provider = provider

    def _run(
        self,
        order_id: str,
        amount_cents: int,
        recipient: str,
    ) -> Any:
        payload = {
            "order_id": order_id,
            "amount_cents": amount_cents,
            "recipient": recipient,
        }

        request = OperationRequest(
            operation_id=stable_operation_id(order_id),
            action_fingerprint=fingerprint_action(
                "charge",
                payload,
            ),
            action=payload,
        )

        try:
            result = self._core.execute(
                request,
                provider=self._provider,
            )

        except UnresolvedOutcome:
            return ToolFailure(
                message=(
                    "Payment outcome is unresolved. Execution is blocked "
                    "pending authoritative provider reconciliation."
                ),
                code="once_outcome_unknown",
                retryable=False,
            )

        except OperationInFlight:
            return ToolFailure(
                message=(
                    "This logical payment is already owned by another "
                    "live execution attempt."
                ),
                code="once_operation_in_flight",
                retryable=True,
            )

        except OperationConflict:
            return ToolFailure(
                message=(
                    "The operation identity was reused with different "
                    "action semantics."
                ),
                code="once_operation_conflict",
                retryable=False,
            )

        except UnsafeProviderCapability:
            return ToolFailure(
                message=(
                    "The provider cannot prove the guarantee required "
                    "for safe re-execution."
                ),
                code="once_provider_unsafe",
                retryable=False,
            )

        except ExecutionRightLost:
            return ToolFailure(
                message=(
                    "This invocation no longer owns the durable execution right."
                ),
                code="once_execution_right_lost",
                retryable=True,
            )

        return {
            "operation_id": result.operation_id,
            "effect_id": result.receipt["effect_id"],
            "execution_state": result.state.value,
            "recovery": result.source.value,
            "fence_token": result.fence_token,
        }


async def dispatch_via_crewai(tool: BaseTool) -> Any:
    """
    Deterministic CrewAI-native tool dispatch.

    CrewAI converts BaseTool instances to CrewStructuredTool and its current
    execution layer calls the structured tool asynchronously. The wrapped
    synchronous _run is therefore executed through CrewAI's native structured
    tool boundary without requiring an LLM/API key.
    """
    structured = tool.to_structured_tool()
    return await structured.ainvoke(input=ACTION)


def print_child_result(result: Any) -> int:
    if isinstance(result, ToolFailure):
        print(
            json.dumps(
                {
                    "phase": "tool_failure",
                    "code": result.code,
                    "retryable": result.retryable,
                    "message": result.message,
                }
            ),
            flush=True,
        )

        if result.code == "once_outcome_unknown":
            return UNKNOWN_EXIT_CODE

        return 1

    print(
        json.dumps(
            {
                "phase": "tool_result",
                "result": result,
            }
        ),
        flush=True,
    )
    return 0


def run_child(args: argparse.Namespace) -> int:
    provider = ProviderLedger(
        Path(args.provider_db),
        crash_after_commit=args.crash_after_commit,
        mode=args.mode,
    )

    if args.mode == "control":
        tool: BaseTool = NativeChargeTool(
            provider=provider,
        )
    else:
        if not args.operations_db:
            raise ValueError("--operations-db is required for protected modes")

        store = SQLiteOperationStore(
            Path(args.operations_db)
        )
        core = OnceCore(
            store,
            lease_ms=LEASE_MS,
        )
        tool = OnceProtectedChargeTool(
            core=core,
            provider=provider,
        )

    print(
        json.dumps(
            {
                "phase": "crewai_dispatch",
                "mode": args.mode,
                "tool_class": type(tool).__name__,
                "path": (
                    "BaseTool -> to_structured_tool() -> "
                    "CrewStructuredTool.ainvoke() -> _run()"
                ),
            }
        ),
        flush=True,
    )

    result = asyncio.run(dispatch_via_crewai(tool))
    return print_child_result(result)


def child_command(
    *,
    mode: str,
    provider_db: Path,
    operations_db: Optional[Path] = None,
    crash_after_commit: bool = False,
) -> list[str]:
    command = [
        sys.executable,
        str(SCRIPT_PATH),
        "child",
        "--mode",
        mode,
        "--provider-db",
        str(provider_db),
    ]

    if operations_db is not None:
        command.extend(
            [
                "--operations-db",
                str(operations_db),
            ]
        )

    if crash_after_commit:
        command.append("--crash-after-commit")

    return command


def run_process(
    *,
    label: str,
    mode: str,
    provider_db: Path,
    operations_db: Optional[Path] = None,
    crash_after_commit: bool = False,
) -> subprocess.CompletedProcess[str]:
    print(f"\n--- {label} ---")

    completed = subprocess.run(
        child_command(
            mode=mode,
            provider_db=provider_db,
            operations_db=operations_db,
            crash_after_commit=crash_after_commit,
        ),
        cwd=SCRIPT_PATH.parent,
        text=True,
        capture_output=True,
    )

    print(f"exit_code={completed.returncode}")

    if completed.stdout:
        print(completed.stdout.rstrip())

    if completed.stderr:
        print("--- stderr ---")
        print(completed.stderr.rstrip())

    return completed


def require_exit(
    completed: subprocess.CompletedProcess[str],
    expected: int,
    label: str,
) -> None:
    if completed.returncode != expected:
        raise AssertionError(
            f"{label}: expected exit code {expected}, "
            f"got {completed.returncode}"
        )


def print_provider_events(provider: ProviderLedger) -> None:
    print("provider_events:")
    for row in provider.events():
        print(
            "  "
            f"{int(row['event_id']):02d} "
            f"{row['event_type']:<24} "
            f"{row['operation_id'] or '-'} "
            f"{row['detail'] or ''}"
        )


def print_operation_events(store: SQLiteOperationStore) -> None:
    print("operation_events:")
    for row in store.list_events(stable_operation_id(ORDER_ID)):
        from_state = row["from_state"] or "-"
        to_state = row["to_state"] or "-"
        print(
            "  "
            f"{int(row['event_id']):02d} "
            f"{row['event_type']:<30} "
            f"state={from_state}->{to_state} "
            f"fence={row['fence_token']} "
            f"version={row['version']}"
        )


def assert_event_present(
    events: list[dict[str, Any]],
    event_type: str,
    *,
    from_state: Optional[str] = None,
    to_state: Optional[str] = None,
) -> None:
    for event in events:
        if event["event_type"] != event_type:
            continue
        if from_state is not None and event["from_state"] != from_state:
            continue
        if to_state is not None and event["to_state"] != to_state:
            continue
        return

    raise AssertionError(
        f"missing operation event {event_type} "
        f"{from_state or '*'}->{to_state or '*'}"
    )


def case_control(root: Path) -> None:
    case_dir = root / "control"
    case_dir.mkdir(parents=True, exist_ok=True)
    provider_db = case_dir / "provider.sqlite"

    first = run_process(
        label="CREWAI CONTROL A: first process",
        mode="control",
        provider_db=provider_db,
        crash_after_commit=True,
    )
    require_exit(first, CRASH_EXIT_CODE, "control first process")

    second = run_process(
        label="CREWAI CONTROL A: fresh-process redispatch",
        mode="control",
        provider_db=provider_db,
        crash_after_commit=False,
    )
    require_exit(second, 0, "control redispatch")

    provider = ProviderLedger(provider_db)
    count = provider.effect_count()
    print_provider_events(provider)

    if count != 2:
        raise AssertionError(
            f"control expected 2 external effects, got {count}"
        )

    print(
        "\nCASE A RESULT: "
        f"external_effects={count} verdict=DUPLICATED"
    )


def case_reconcile(root: Path) -> None:
    case_dir = root / "reconcile"
    case_dir.mkdir(parents=True, exist_ok=True)
    provider_db = case_dir / "provider.sqlite"
    operations_db = case_dir / "operations.sqlite"

    first = run_process(
        label="CREWAI + ONCE B: first process",
        mode="protected",
        provider_db=provider_db,
        operations_db=operations_db,
        crash_after_commit=True,
    )
    require_exit(first, CRASH_EXIT_CODE, "protected first process")

    # A process death does not itself erase a lease. Wait for the short lab
    # lease to expire before redispatch so the fresh invocation reconciles.
    time.sleep(LEASE_SETTLE_SECONDS)

    second = run_process(
        label="CREWAI + ONCE B: fresh-process redispatch",
        mode="protected",
        provider_db=provider_db,
        operations_db=operations_db,
        crash_after_commit=False,
    )
    require_exit(second, 0, "protected redispatch")

    provider = ProviderLedger(provider_db)
    store = SQLiteOperationStore(operations_db)

    count = provider.effect_count()
    record = store.get(stable_operation_id(ORDER_ID))

    print_provider_events(provider)
    print_operation_events(store)

    if count != 1:
        raise AssertionError(
            f"protected reconciliation expected 1 effect, got {count}"
        )

    if record is None or record.state != OperationState.CONFIRMED:
        raise AssertionError(
            "protected reconciliation did not finish CONFIRMED"
        )

    events = store.list_events(stable_operation_id(ORDER_ID))
    assert_event_present(
        events,
        "CLAIM_ACQUIRED",
        to_state="CLAIMED",
    )
    assert_event_present(
        events,
        "EXECUTE_STARTED",
        from_state="CLAIMED",
        to_state="CLAIMED",
    )
    assert_event_present(
        events,
        "RECONCILE_STARTED",
        from_state="CLAIMED",
        to_state="CLAIMED",
    )
    assert_event_present(
        events,
        "RECONCILE_CONFIRMED",
        from_state="CLAIMED",
        to_state="CONFIRMED",
    )

    print(
        "\nCASE B RESULT: "
        f"external_effects={count} "
        "recovery=RECONCILED state=CONFIRMED"
    )


def case_unknown_and_recovery(root: Path) -> None:
    case_dir = root / "unknown"
    case_dir.mkdir(parents=True, exist_ok=True)
    provider_db = case_dir / "provider.sqlite"
    operations_db = case_dir / "operations.sqlite"

    first = run_process(
        label="CREWAI + ONCE C: first process",
        mode="unknown",
        provider_db=provider_db,
        operations_db=operations_db,
        crash_after_commit=True,
    )
    require_exit(first, CRASH_EXIT_CODE, "unknown first process")

    provider = ProviderLedger(provider_db)
    provider.set_truth_available(False)

    time.sleep(LEASE_SETTLE_SECONDS)

    blocked = run_process(
        label="CREWAI + ONCE C: truth unavailable",
        mode="unknown",
        provider_db=provider_db,
        operations_db=operations_db,
        crash_after_commit=False,
    )
    require_exit(blocked, UNKNOWN_EXIT_CODE, "unknown blocked redispatch")

    store = SQLiteOperationStore(operations_db)
    count_after_block = provider.effect_count()
    record_after_block = store.get(stable_operation_id(ORDER_ID))

    print_provider_events(provider)
    print_operation_events(store)

    if count_after_block != 1:
        raise AssertionError(
            "UNKNOWN path performed a second external write"
        )

    if (
        record_after_block is None
        or record_after_block.state != OperationState.UNKNOWN
    ):
        raise AssertionError(
            "UNKNOWN path did not persist OperationState.UNKNOWN"
        )

    unknown_events = store.list_events(
        stable_operation_id(ORDER_ID)
    )
    assert_event_present(
        unknown_events,
        "OUTCOME_UNKNOWN",
        from_state="CLAIMED",
        to_state="UNKNOWN",
    )
    assert_event_present(
        unknown_events,
        "RECONCILE_UNKNOWN",
        from_state="UNKNOWN",
        to_state="UNKNOWN",
    )

    print(
        "\nCASE C RESULT: "
        "external_effects=1 state=UNKNOWN verdict=BLOCKED"
    )

    provider.set_truth_available(True)

    recovered = run_process(
        label="CREWAI + ONCE C2: truth restored",
        mode="unknown",
        provider_db=provider_db,
        operations_db=operations_db,
        crash_after_commit=False,
    )
    require_exit(recovered, 0, "unknown recovery redispatch")

    final_store = SQLiteOperationStore(operations_db)
    final_provider = ProviderLedger(provider_db)
    final_record = final_store.get(stable_operation_id(ORDER_ID))
    final_count = final_provider.effect_count()

    print_provider_events(final_provider)
    print_operation_events(final_store)

    if final_count != 1:
        raise AssertionError(
            "UNKNOWN recovery created a second external effect"
        )

    if final_record is None or final_record.state != OperationState.CONFIRMED:
        raise AssertionError(
            "UNKNOWN recovery did not move to CONFIRMED"
        )

    final_events = final_store.list_events(
        stable_operation_id(ORDER_ID)
    )
    assert_event_present(
        final_events,
        "RECONCILE_STARTED",
        from_state="UNKNOWN",
        to_state="UNKNOWN",
    )
    assert_event_present(
        final_events,
        "RECONCILE_CONFIRMED",
        from_state="UNKNOWN",
        to_state="CONFIRMED",
    )

    print(
        "\nCASE C2 RESULT: "
        "external_effects=1 "
        "transition=UNKNOWN->CONFIRMED "
        "recovery=RECONCILED"
    )


def run_suite() -> None:
    print("Once V4 CrewAI portability regression gate")
    print("Frozen core baseline: commit 114e39e")
    print(
        "CrewAI dispatch path: "
        "BaseTool -> to_structured_tool() -> "
        "CrewStructuredTool.ainvoke() -> _run()"
    )
    print(
        "\nThe provider deliberately does NOT deduplicate writes. "
        "If Once permits a second protected execute, it will be visible."
    )

    with tempfile.TemporaryDirectory(
        prefix="once-crewai-v4-"
    ) as tmp:
        root = Path(tmp)

        case_control(root)
        case_reconcile(root)
        case_unknown_and_recovery(root)

    print("\nPASS: Once V4 CrewAI portability regression gate held.")
    print("CASE A  CONTROL    -> 2 effects -> DUPLICATED")
    print("CASE B  ONCE       -> 1 effect  -> CONFIRMED")
    print("CASE C  UNKNOWN    -> 1 effect  -> BLOCKED")
    print(
        "CASE C2 RECOVERY   -> 1 effect  -> "
        "UNKNOWN->CONFIRMED"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Once V4 CrewAI hostile-retry portability lab"
    )

    subparsers = parser.add_subparsers(
        dest="command",
        required=True,
    )

    subparsers.add_parser(
        "run",
        help="run the complete evidence matrix",
    )

    child = subparsers.add_parser(
        "child",
        help="internal fresh-process worker",
    )
    child.add_argument(
        "--mode",
        choices=("control", "protected", "unknown"),
        required=True,
    )
    child.add_argument(
        "--provider-db",
        required=True,
    )
    child.add_argument(
        "--operations-db",
    )
    child.add_argument(
        "--crash-after-commit",
        action="store_true",
    )

    return parser


def main() -> int:
    args = build_parser().parse_args()

    if args.command == "run":
        run_suite()
        return 0

    if args.command == "child":
        return run_child(args)

    raise AssertionError(f"unsupported command: {args.command!r}")


if __name__ == "__main__":
    raise SystemExit(main())

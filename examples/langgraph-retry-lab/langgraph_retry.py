from __future__ import annotations

"""
LangGraph hostile-retry lab, Version 3.

This script demonstrates five framework-level crash/recovery outcomes with:
- real LangGraph StateGraph execution
- real SqliteSaver persistence
- an independent provider SQLite database as external-world truth
- a separate durable operation ledger as execution-safety truth
- hard os._exit(77) process termination immediately after provider commit
- fresh-process recovery against the same persisted LangGraph thread

Cases:
1. naive random UUID -> duplicate external effect after crash/restart
2. stable business identity + provider idempotency -> one external effect
3. durable claim + reconciliation -> CONFIRMED without a second write
4. provider truth unavailable -> UNKNOWN / fail closed
4B. provider truth later returns -> UNKNOWN -> CONFIRMED, still one effect

The verdict is always based on the independent provider ledger, not on what the
workflow believes happened.
"""

import argparse
from contextlib import closing
from dataclasses import asdict, dataclass
from enum import Enum
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from typing import TypedDict

os.environ.setdefault("LANGGRAPH_STRICT_MSGPACK", "true")

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph


CRASH_EXIT_CODE = 77
UNKNOWN_EXIT_CODE = 78


class Truth(str, Enum):
    CONFIRMED = "CONFIRMED"
    ABSENT = "ABSENT"
    UNKNOWN = "UNKNOWN"


class OperationState(str, Enum):
    CLAIMED = "CLAIMED"
    CONFIRMED = "CONFIRMED"
    UNKNOWN = "UNKNOWN"


class UnresolvedOutcome(RuntimeError):
    """Provider truth is insufficient to decide whether re-execution is safe."""


class ChargeState(TypedDict, total=False):
    order_id: str
    amount_cents: int
    payment_key: str
    charged: bool
    effect_id: str
    execution_state: str
    recovery: str


@dataclass(frozen=True)
class Receipt:
    operation_key: str
    effect_id: str
    order_id: str
    amount_cents: int
    deduped: bool = False


@dataclass(frozen=True)
class OperationRecord:
    operation_key: str
    state: OperationState
    receipt: Receipt | None


def stable_operation_key(order_id: str) -> str:
    return f"charge:{order_id}"


class ProviderLedger:
    """
    Simulated external provider.

    provider.sqlite is deliberately independent from:
    - LangGraph checkpoint state
    - the Once-like operation ledger

    UNIQUE(operation_key) models provider-supported idempotency.

    provider_events is a forensic black-box recorder. Its event ordering lets us
    prove whether a second charge request happened, whether a second effect was
    committed, and whether recovery used provider truth instead.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
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
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS effects (
                    effect_id TEXT PRIMARY KEY,
                    operation_key TEXT NOT NULL UNIQUE,
                    order_id TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS provider_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    operation_key TEXT,
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
        operation_key: str | None,
        detail: str | None = None,
    ) -> None:
        conn.execute(
            """
            INSERT INTO provider_events(
                event_type,
                operation_key,
                detail
            )
            VALUES (?, ?, ?)
            """,
            (event_type, operation_key, detail),
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

    def charge(
        self,
        operation_key: str,
        order_id: str,
        amount_cents: int,
    ) -> Receipt:
        conn = self._connect()

        try:
            conn.execute("BEGIN IMMEDIATE")
            self._log(
                conn,
                "CHARGE_REQUEST",
                operation_key,
                f"order_id={order_id};amount_cents={amount_cents}",
            )

            existing = conn.execute(
                """
                SELECT effect_id, operation_key, order_id, amount_cents
                FROM effects
                WHERE operation_key = ?
                """,
                (operation_key,),
            ).fetchone()

            if existing is not None:
                self._log(
                    conn,
                    "IDEMPOTENT_REPLAY",
                    operation_key,
                    existing["effect_id"],
                )
                conn.execute("COMMIT")
                return Receipt(
                    operation_key=existing["operation_key"],
                    effect_id=existing["effect_id"],
                    order_id=existing["order_id"],
                    amount_cents=existing["amount_cents"],
                    deduped=True,
                )

            next_number = conn.execute(
                "SELECT COUNT(*) + 1 AS n FROM effects"
            ).fetchone()["n"]

            effect_id = f"charge_{next_number}"

            conn.execute(
                """
                INSERT INTO effects(
                    effect_id,
                    operation_key,
                    order_id,
                    amount_cents
                )
                VALUES (?, ?, ?, ?)
                """,
                (
                    effect_id,
                    operation_key,
                    order_id,
                    amount_cents,
                ),
            )

            self._log(
                conn,
                "EFFECT_COMMITTED",
                operation_key,
                effect_id,
            )

            conn.execute("COMMIT")

            return Receipt(
                operation_key=operation_key,
                effect_id=effect_id,
                order_id=order_id,
                amount_cents=amount_cents,
                deduped=False,
            )

        except BaseException:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()

    def get_status(
        self,
        operation_key: str,
    ) -> tuple[Truth, Receipt | None]:
        conn = self._connect()

        try:
            conn.execute("BEGIN IMMEDIATE")

            self._log(
                conn,
                "STATUS_QUERY",
                operation_key,
            )

            control = conn.execute(
                """
                SELECT truth_available
                FROM provider_control
                WHERE singleton = 1
                """
            ).fetchone()

            if not bool(control["truth_available"]):
                self._log(
                    conn,
                    "STATUS_UNKNOWN",
                    operation_key,
                    "provider truth unavailable",
                )
                conn.execute("COMMIT")
                return Truth.UNKNOWN, None

            row = conn.execute(
                """
                SELECT effect_id, operation_key, order_id, amount_cents
                FROM effects
                WHERE operation_key = ?
                """,
                (operation_key,),
            ).fetchone()

            if row is None:
                self._log(
                    conn,
                    "STATUS_ABSENT",
                    operation_key,
                    "authoritative absence",
                )
                conn.execute("COMMIT")
                return Truth.ABSENT, None

            self._log(
                conn,
                "STATUS_CONFIRMED",
                operation_key,
                row["effect_id"],
            )
            conn.execute("COMMIT")

            return (
                Truth.CONFIRMED,
                Receipt(
                    operation_key=row["operation_key"],
                    effect_id=row["effect_id"],
                    order_id=row["order_id"],
                    amount_cents=row["amount_cents"],
                    deduped=False,
                ),
            )

        except BaseException:
            try:
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

    def list_effects(self) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute(
                """
                SELECT
                    effect_id,
                    operation_key,
                    order_id,
                    amount_cents,
                    created_at
                FROM effects
                ORDER BY rowid
                """
            ).fetchall()
            return [dict(row) for row in rows]

    def list_events(self) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute(
                """
                SELECT
                    id,
                    event_type,
                    operation_key,
                    detail,
                    created_at
                FROM provider_events
                ORDER BY id
                """
            ).fetchall()
            return [dict(row) for row in rows]

    def count_event(self, event_type: str) -> int:
        with closing(self._connect()) as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS n
                FROM provider_events
                WHERE event_type = ?
                """,
                (event_type,),
            ).fetchone()
            return int(row["n"])


class OperationLedger:
    """
    Durable Once-like operation state.

    operations.sqlite answers a different question from the LangGraph
    checkpointer:

      LangGraph checkpoint:
          What did the workflow successfully persist?

      Operation ledger:
          What logical external operation was already claimed / resolved?

    CLAIMED is committed before provider execution.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
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
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS operations (
                    operation_key TEXT PRIMARY KEY,
                    state TEXT NOT NULL,
                    receipt_json TEXT,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS operation_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    operation_key TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    detail TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

    @staticmethod
    def _log(
        conn: sqlite3.Connection,
        operation_key: str,
        event_type: str,
        detail: str | None = None,
    ) -> None:
        conn.execute(
            """
            INSERT INTO operation_events(
                operation_key,
                event_type,
                detail
            )
            VALUES (?, ?, ?)
            """,
            (operation_key, event_type, detail),
        )

    def get(
        self,
        operation_key: str,
    ) -> OperationRecord | None:
        with closing(self._connect()) as conn:
            row = conn.execute(
                """
                SELECT operation_key, state, receipt_json
                FROM operations
                WHERE operation_key = ?
                """,
                (operation_key,),
            ).fetchone()

        if row is None:
            return None

        receipt = (
            None
            if row["receipt_json"] is None
            else Receipt(**json.loads(row["receipt_json"]))
        )

        return OperationRecord(
            operation_key=row["operation_key"],
            state=OperationState(row["state"]),
            receipt=receipt,
        )

    def claim(self, operation_key: str) -> OperationRecord:
        conn = self._connect()

        try:
            conn.execute("BEGIN IMMEDIATE")

            row = conn.execute(
                """
                SELECT operation_key, state, receipt_json
                FROM operations
                WHERE operation_key = ?
                """,
                (operation_key,),
            ).fetchone()

            if row is None:
                conn.execute(
                    """
                    INSERT INTO operations(
                        operation_key,
                        state,
                        receipt_json,
                        updated_at
                    )
                    VALUES (?, ?, NULL, CURRENT_TIMESTAMP)
                    """,
                    (operation_key, OperationState.CLAIMED.value),
                )

                self._log(
                    conn,
                    operation_key,
                    "CLAIMED",
                    "durable before provider execution",
                )

                conn.execute("COMMIT")

                return OperationRecord(
                    operation_key=operation_key,
                    state=OperationState.CLAIMED,
                    receipt=None,
                )

            conn.execute("COMMIT")

            receipt = (
                None
                if row["receipt_json"] is None
                else Receipt(**json.loads(row["receipt_json"]))
            )

            return OperationRecord(
                operation_key=row["operation_key"],
                state=OperationState(row["state"]),
                receipt=receipt,
            )

        except BaseException:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()

    def settle(
        self,
        operation_key: str,
        receipt: Receipt,
        *,
        event_type: str,
    ) -> None:
        conn = self._connect()

        try:
            conn.execute("BEGIN IMMEDIATE")

            conn.execute(
                """
                INSERT INTO operations(
                    operation_key,
                    state,
                    receipt_json,
                    updated_at
                )
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(operation_key) DO UPDATE SET
                    state = excluded.state,
                    receipt_json = excluded.receipt_json,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    operation_key,
                    OperationState.CONFIRMED.value,
                    json.dumps(asdict(receipt)),
                ),
            )

            self._log(
                conn,
                operation_key,
                event_type,
                receipt.effect_id,
            )

            conn.execute("COMMIT")

        except BaseException:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()

    def mark_unknown(self, operation_key: str) -> None:
        conn = self._connect()

        try:
            conn.execute("BEGIN IMMEDIATE")

            conn.execute(
                """
                INSERT INTO operations(
                    operation_key,
                    state,
                    receipt_json,
                    updated_at
                )
                VALUES (?, ?, NULL, CURRENT_TIMESTAMP)
                ON CONFLICT(operation_key) DO UPDATE SET
                    state = excluded.state,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    operation_key,
                    OperationState.UNKNOWN.value,
                ),
            )

            self._log(
                conn,
                operation_key,
                "UNKNOWN",
                "provider truth insufficient; execution blocked",
            )

            conn.execute("COMMIT")

        except BaseException:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()

    def list_events(self) -> list[dict]:
        with closing(self._connect()) as conn:
            rows = conn.execute(
                """
                SELECT
                    id,
                    operation_key,
                    event_type,
                    detail,
                    created_at
                FROM operation_events
                ORDER BY id
                """
            ).fetchall()
            return [dict(row) for row in rows]


def hard_crash_after_provider_commit(
    *,
    mode: str,
    operation_key: str,
    receipt: Receipt,
) -> None:
    print(
        json.dumps(
            {
                "phase": "hard_crash",
                "mode": mode,
                "operation_key": operation_key,
                "effect_id": receipt.effect_id,
                "exit_code": CRASH_EXIT_CODE,
                "message": (
                    "provider effect is durable; terminating before node output "
                    "or success receipt can become local checkpoint state"
                ),
            }
        ),
        flush=True,
    )

    os._exit(CRASH_EXIT_CODE)


def make_graph(
    *,
    graph_db: Path,
    provider_db: Path,
    operations_db: Path,
    mode: str,
    crash_after_effect: bool,
):
    provider = ProviderLedger(provider_db)
    operations = OperationLedger(operations_db)

    def charge_node(state: ChargeState) -> ChargeState:
        order_id = state["order_id"]
        amount_cents = state["amount_cents"]

        if mode == "naive":
            operation_key = state.get("payment_key") or str(uuid.uuid4())

            receipt = provider.charge(
                operation_key,
                order_id,
                amount_cents,
            )

            print(
                json.dumps(
                    {
                        "phase": "provider_committed",
                        "mode": mode,
                        "operation_key": operation_key,
                        "effect_id": receipt.effect_id,
                        "deduped": receipt.deduped,
                    }
                ),
                flush=True,
            )

            if crash_after_effect:
                hard_crash_after_provider_commit(
                    mode=mode,
                    operation_key=operation_key,
                    receipt=receipt,
                )

            return {
                "payment_key": operation_key,
                "charged": True,
                "effect_id": receipt.effect_id,
                "execution_state": "CONFIRMED",
                "recovery": (
                    "IDEMPOTENT_REPLAY"
                    if receipt.deduped
                    else "EXECUTED"
                ),
            }

        if mode == "stable":
            operation_key = stable_operation_key(order_id)

            receipt = provider.charge(
                operation_key,
                order_id,
                amount_cents,
            )

            print(
                json.dumps(
                    {
                        "phase": "provider_committed",
                        "mode": mode,
                        "operation_key": operation_key,
                        "effect_id": receipt.effect_id,
                        "deduped": receipt.deduped,
                    }
                ),
                flush=True,
            )

            if crash_after_effect:
                hard_crash_after_provider_commit(
                    mode=mode,
                    operation_key=operation_key,
                    receipt=receipt,
                )

            return {
                "payment_key": operation_key,
                "charged": True,
                "effect_id": receipt.effect_id,
                "execution_state": "CONFIRMED",
                "recovery": (
                    "IDEMPOTENT_REPLAY"
                    if receipt.deduped
                    else "EXECUTED"
                ),
            }

        if mode not in {"reconcile", "unknown"}:
            raise ValueError(f"unsupported mode: {mode}")

        operation_key = stable_operation_key(order_id)
        local = operations.get(operation_key)

        if local is not None and local.state == OperationState.CONFIRMED:
            if local.receipt is None:
                raise RuntimeError(
                    "CONFIRMED operation is missing its durable receipt"
                )

            print(
                json.dumps(
                    {
                        "phase": "operation_replay",
                        "mode": mode,
                        "operation_key": operation_key,
                        "state": local.state.value,
                        "effect_id": local.receipt.effect_id,
                    }
                ),
                flush=True,
            )

            return {
                "payment_key": operation_key,
                "charged": True,
                "effect_id": local.receipt.effect_id,
                "execution_state": "CONFIRMED",
                "recovery": "REPLAYED",
            }

        if local is not None and local.state in {
            OperationState.CLAIMED,
            OperationState.UNKNOWN,
        }:
            truth, receipt = provider.get_status(operation_key)

            print(
                json.dumps(
                    {
                        "phase": "reconciliation",
                        "mode": mode,
                        "operation_key": operation_key,
                        "local_state": local.state.value,
                        "provider_truth": truth.value,
                        "effect_id": (
                            None if receipt is None else receipt.effect_id
                        ),
                    }
                ),
                flush=True,
            )

            if truth == Truth.CONFIRMED:
                if receipt is None:
                    raise RuntimeError(
                        "provider returned CONFIRMED without a receipt"
                    )

                operations.settle(
                    operation_key,
                    receipt,
                    event_type="RECONCILED_CONFIRMED",
                )

                return {
                    "payment_key": operation_key,
                    "charged": True,
                    "effect_id": receipt.effect_id,
                    "execution_state": "CONFIRMED",
                    "recovery": "RECONCILED",
                }

            if truth == Truth.UNKNOWN:
                operations.mark_unknown(operation_key)

                raise UnresolvedOutcome(
                    "provider truth is UNKNOWN; refusing another external write"
                )

            # ABSENT here means authoritative absence, not a timeout or missing
            # local receipt. Only this branch permits another execution.
            if truth != Truth.ABSENT:
                raise RuntimeError(
                    f"unexpected provider truth: {truth!r}"
                )

        # NONE -> durable CLAIMED before external execution.
        # CLAIMED/UNKNOWN + authoritative ABSENT -> execute same logical key.
        operations.claim(operation_key)

        receipt = provider.charge(
            operation_key,
            order_id,
            amount_cents,
        )

        print(
            json.dumps(
                {
                    "phase": "provider_committed",
                    "mode": mode,
                    "operation_key": operation_key,
                    "effect_id": receipt.effect_id,
                    "deduped": receipt.deduped,
                    "operation_state_before_crash": "CLAIMED",
                }
            ),
            flush=True,
        )

        if crash_after_effect:
            hard_crash_after_provider_commit(
                mode=mode,
                operation_key=operation_key,
                receipt=receipt,
            )

        operations.settle(
            operation_key,
            receipt,
            event_type="EXECUTION_CONFIRMED",
        )

        return {
            "payment_key": operation_key,
            "charged": True,
            "effect_id": receipt.effect_id,
            "execution_state": "CONFIRMED",
            "recovery": (
                "IDEMPOTENT_REPLAY"
                if receipt.deduped
                else "EXECUTED"
            ),
        }

    builder = StateGraph(ChargeState)
    builder.add_node("charge", charge_node)
    builder.add_edge(START, "charge")
    builder.add_edge("charge", END)

    checkpointer_cm = SqliteSaver.from_conn_string(str(graph_db))
    checkpointer = checkpointer_cm.__enter__()
    graph = builder.compile(checkpointer=checkpointer)

    return graph, checkpointer_cm


def run_child(args: argparse.Namespace) -> int:
    graph_db = Path(args.graph_db).resolve()
    provider_db = Path(args.provider_db).resolve()
    operations_db = Path(args.operations_db).resolve()

    for path in (graph_db, provider_db, operations_db):
        path.parent.mkdir(parents=True, exist_ok=True)

    config = {
        "configurable": {
            "thread_id": args.thread_id,
        }
    }

    graph, checkpointer_cm = make_graph(
        graph_db=graph_db,
        provider_db=provider_db,
        operations_db=operations_db,
        mode=args.mode,
        crash_after_effect=args.crash_after_effect,
    )

    try:
        try:
            if args.action == "start":
                result = graph.invoke(
                    {
                        "order_id": args.order_id,
                        "amount_cents": args.amount_cents,
                    },
                    config,
                    durability="sync",
                )

            elif args.action == "resume":
                result = graph.invoke(
                    None,
                    config,
                    durability="sync",
                )

            else:
                raise ValueError(
                    f"unsupported child action: {args.action}"
                )

        except UnresolvedOutcome as exc:
            print(
                json.dumps(
                    {
                        "phase": "blocked_unknown",
                        "mode": args.mode,
                        "state": "UNKNOWN",
                        "verdict": "BLOCKED",
                        "message": str(exc),
                    }
                ),
                flush=True,
            )
            return UNKNOWN_EXIT_CODE

        print(
            json.dumps(
                {
                    "phase": "graph_returned",
                    "action": args.action,
                    "mode": args.mode,
                    "result": result,
                },
                default=str,
            ),
            flush=True,
        )

        return 0

    finally:
        checkpointer_cm.__exit__(None, None, None)


def run_subprocess(command: list[str]) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["LANGGRAPH_STRICT_MSGPACK"] = "true"

    return subprocess.run(
        command,
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )


def child_command(
    *,
    action: str,
    mode: str,
    graph_db: Path,
    provider_db: Path,
    operations_db: Path,
    thread_id: str,
    crash_after_effect: bool,
) -> list[str]:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--child",
        "--action",
        action,
        "--mode",
        mode,
        "--graph-db",
        str(graph_db),
        "--provider-db",
        str(provider_db),
        "--operations-db",
        str(operations_db),
        "--thread-id",
        thread_id,
        "--order-id",
        "order_123",
        "--amount-cents",
        "4200",
    ]

    if crash_after_effect:
        command.append("--crash-after-effect")

    return command


def show_process(
    label: str,
    result: subprocess.CompletedProcess[str],
) -> None:
    print(f"\n--- {label} ---")
    print(f"exit_code={result.returncode}")

    if result.stdout.strip():
        print(result.stdout.rstrip())

    if result.stderr.strip():
        print("[stderr]")
        print(result.stderr.rstrip())


def print_forensics(
    provider: ProviderLedger,
    operations: OperationLedger,
) -> None:
    print("\nprovider_events:")
    for event in provider.list_events():
        print(
            f"  {event['id']:02d} "
            f"{event['event_type']:<20} "
            f"{event['operation_key'] or '-'} "
            f"{event['detail'] or ''}"
        )

    operation_events = operations.list_events()

    if operation_events:
        print("operation_events:")
        for event in operation_events:
            print(
                f"  {event['id']:02d} "
                f"{event['event_type']:<22} "
                f"{event['operation_key']} "
                f"{event['detail'] or ''}"
            )


def make_paths(root: Path) -> tuple[Path, Path, Path]:
    return (
        root / "langgraph.sqlite",
        root / "provider.sqlite",
        root / "operations.sqlite",
    )


def run_case_naive() -> None:
    with tempfile.TemporaryDirectory(
        prefix="once-langgraph-naive-"
    ) as tmp:
        root = Path(tmp)
        graph_db, provider_db, operations_db = make_paths(root)
        provider = ProviderLedger(provider_db)
        operations = OperationLedger(operations_db)
        thread_id = "hostile-retry-naive"

        first = run_subprocess(
            child_command(
                action="start",
                mode="naive",
                graph_db=graph_db,
                provider_db=provider_db,
                operations_db=operations_db,
                thread_id=thread_id,
                crash_after_effect=True,
            )
        )
        show_process("CASE 1 naive: first process", first)

        assert first.returncode == CRASH_EXIT_CODE
        assert provider.effect_count() == 1

        resumed = run_subprocess(
            child_command(
                action="resume",
                mode="naive",
                graph_db=graph_db,
                provider_db=provider_db,
                operations_db=operations_db,
                thread_id=thread_id,
                crash_after_effect=False,
            )
        )
        show_process("CASE 1 naive: fresh-process resume", resumed)

        assert resumed.returncode == 0
        assert provider.effect_count() == 2
        assert provider.count_event("CHARGE_REQUEST") == 2
        assert provider.count_event("EFFECT_COMMITTED") == 2

        print_forensics(provider, operations)
        print(
            "\nCASE 1 RESULT: "
            "external_effects=2 verdict=DUPLICATED"
        )


def run_case_stable() -> None:
    with tempfile.TemporaryDirectory(
        prefix="once-langgraph-stable-"
    ) as tmp:
        root = Path(tmp)
        graph_db, provider_db, operations_db = make_paths(root)
        provider = ProviderLedger(provider_db)
        operations = OperationLedger(operations_db)
        thread_id = "hostile-retry-stable"

        first = run_subprocess(
            child_command(
                action="start",
                mode="stable",
                graph_db=graph_db,
                provider_db=provider_db,
                operations_db=operations_db,
                thread_id=thread_id,
                crash_after_effect=True,
            )
        )
        show_process("CASE 2 stable: first process", first)

        assert first.returncode == CRASH_EXIT_CODE
        assert provider.effect_count() == 1

        resumed = run_subprocess(
            child_command(
                action="resume",
                mode="stable",
                graph_db=graph_db,
                provider_db=provider_db,
                operations_db=operations_db,
                thread_id=thread_id,
                crash_after_effect=False,
            )
        )
        show_process("CASE 2 stable: fresh-process resume", resumed)

        assert resumed.returncode == 0
        assert provider.effect_count() == 1
        assert provider.count_event("CHARGE_REQUEST") == 2
        assert provider.count_event("EFFECT_COMMITTED") == 1
        assert provider.count_event("IDEMPOTENT_REPLAY") == 1

        print_forensics(provider, operations)
        print(
            "\nCASE 2 RESULT: "
            "external_effects=1 verdict=ONE_EXTERNAL_EFFECT"
        )


def run_case_reconcile() -> None:
    with tempfile.TemporaryDirectory(
        prefix="once-langgraph-reconcile-"
    ) as tmp:
        root = Path(tmp)
        graph_db, provider_db, operations_db = make_paths(root)
        provider = ProviderLedger(provider_db)
        operations = OperationLedger(operations_db)
        thread_id = "hostile-retry-reconcile"
        operation_key = stable_operation_key("order_123")

        first = run_subprocess(
            child_command(
                action="start",
                mode="reconcile",
                graph_db=graph_db,
                provider_db=provider_db,
                operations_db=operations_db,
                thread_id=thread_id,
                crash_after_effect=True,
            )
        )
        show_process("CASE 3 reconcile: first process", first)

        assert first.returncode == CRASH_EXIT_CODE
        assert provider.effect_count() == 1

        local = operations.get(operation_key)
        assert local is not None
        assert local.state == OperationState.CLAIMED

        resumed = run_subprocess(
            child_command(
                action="resume",
                mode="reconcile",
                graph_db=graph_db,
                provider_db=provider_db,
                operations_db=operations_db,
                thread_id=thread_id,
                crash_after_effect=False,
            )
        )
        show_process("CASE 3 reconcile: fresh-process resume", resumed)

        assert resumed.returncode == 0
        assert provider.effect_count() == 1
        assert provider.count_event("CHARGE_REQUEST") == 1
        assert provider.count_event("STATUS_QUERY") == 1
        assert provider.count_event("STATUS_CONFIRMED") == 1

        local = operations.get(operation_key)
        assert local is not None
        assert local.state == OperationState.CONFIRMED
        assert local.receipt is not None

        print_forensics(provider, operations)
        print(
            "\nCASE 3 RESULT: "
            "external_effects=1 recovery=RECONCILED "
            "state=CONFIRMED"
        )


def run_case_unknown_then_recover() -> None:
    with tempfile.TemporaryDirectory(
        prefix="once-langgraph-unknown-"
    ) as tmp:
        root = Path(tmp)
        graph_db, provider_db, operations_db = make_paths(root)
        provider = ProviderLedger(provider_db)
        operations = OperationLedger(operations_db)
        thread_id = "hostile-retry-unknown"
        operation_key = stable_operation_key("order_123")

        first = run_subprocess(
            child_command(
                action="start",
                mode="unknown",
                graph_db=graph_db,
                provider_db=provider_db,
                operations_db=operations_db,
                thread_id=thread_id,
                crash_after_effect=True,
            )
        )
        show_process("CASE 4 unknown: first process", first)

        assert first.returncode == CRASH_EXIT_CODE
        assert provider.effect_count() == 1

        local = operations.get(operation_key)
        assert local is not None
        assert local.state == OperationState.CLAIMED

        provider.set_truth_available(False)

        blocked = run_subprocess(
            child_command(
                action="resume",
                mode="unknown",
                graph_db=graph_db,
                provider_db=provider_db,
                operations_db=operations_db,
                thread_id=thread_id,
                crash_after_effect=False,
            )
        )
        show_process(
            "CASE 4 unknown: provider truth unavailable",
            blocked,
        )

        assert blocked.returncode == UNKNOWN_EXIT_CODE
        assert provider.effect_count() == 1
        assert provider.count_event("CHARGE_REQUEST") == 1
        assert provider.count_event("STATUS_QUERY") == 1
        assert provider.count_event("STATUS_UNKNOWN") == 1

        local = operations.get(operation_key)
        assert local is not None
        assert local.state == OperationState.UNKNOWN

        print_forensics(provider, operations)
        print(
            "\nCASE 4 RESULT: "
            "external_effects=1 state=UNKNOWN verdict=BLOCKED"
        )

        provider.set_truth_available(True)

        recovered = run_subprocess(
            child_command(
                action="resume",
                mode="unknown",
                graph_db=graph_db,
                provider_db=provider_db,
                operations_db=operations_db,
                thread_id=thread_id,
                crash_after_effect=False,
            )
        )
        show_process(
            "CASE 4B unknown -> confirmed: truth restored",
            recovered,
        )

        assert recovered.returncode == 0
        assert provider.effect_count() == 1
        assert provider.count_event("CHARGE_REQUEST") == 1
        assert provider.count_event("STATUS_QUERY") == 2
        assert provider.count_event("STATUS_CONFIRMED") == 1

        local = operations.get(operation_key)
        assert local is not None
        assert local.state == OperationState.CONFIRMED
        assert local.receipt is not None

        print_forensics(provider, operations)
        print(
            "\nCASE 4B RESULT: "
            "external_effects=1 transition=UNKNOWN->CONFIRMED "
            "recovery=RECONCILED"
        )


def run_supervisor() -> int:
    print("LangGraph hostile-retry lab — reconciliation edition")
    print()
    print("Three independent durable truths:")
    print("  langgraph.sqlite  = workflow checkpoint truth")
    print("  operations.sqlite = logical operation truth")
    print("  provider.sqlite   = external-world truth")
    print()
    print(
        "Checkpoint state tells you what the workflow remembers. "
        "Reconciliation tells you what reality did."
    )
    print()

    run_case_naive()
    run_case_stable()
    run_case_reconcile()
    run_case_unknown_then_recover()

    print()
    print("PASS: all framework-level hostile-retry invariants held.")
    print(
        "CASE 1  NAIVE      -> 2 effects -> DUPLICATED"
    )
    print(
        "CASE 2  STABLE     -> 1 effect  -> provider dedupe"
    )
    print(
        "CASE 3  RECONCILE  -> 1 effect  -> CONFIRMED"
    )
    print(
        "CASE 4  UNKNOWN    -> 1 effect  -> BLOCKED"
    )
    print(
        "CASE 4B RECOVERY   -> 1 effect  -> UNKNOWN->CONFIRMED"
    )

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "LangGraph hostile-retry lab with stable identity, durable claims, "
            "provider reconciliation, UNKNOWN fail-closed behavior, and "
            "fresh-process recovery."
        )
    )

    parser.add_argument(
        "--child",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--action",
        choices=["start", "resume"],
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--mode",
        choices=["naive", "stable", "reconcile", "unknown"],
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--graph-db",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--provider-db",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--operations-db",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--thread-id",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--order-id",
        default="order_123",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--amount-cents",
        type=int,
        default=4200,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--crash-after-effect",
        action="store_true",
        help=argparse.SUPPRESS,
    )

    return parser


def validate_child_args(args: argparse.Namespace) -> None:
    required = {
        "--action": args.action,
        "--mode": args.mode,
        "--graph-db": args.graph_db,
        "--provider-db": args.provider_db,
        "--operations-db": args.operations_db,
        "--thread-id": args.thread_id,
    }

    missing = [name for name, value in required.items() if not value]

    if missing:
        raise SystemExit(
            "missing child arguments: " + ", ".join(missing)
        )


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.child:
        validate_child_args(args)
        return run_child(args)

    return run_supervisor()


if __name__ == "__main__":
    raise SystemExit(main())

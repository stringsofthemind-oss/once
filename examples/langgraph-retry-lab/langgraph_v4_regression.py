from __future__ import annotations

"""Once V4 LangGraph regression gate.

This runner preserves the two historical control cases and routes the recovery
cases through the framework-neutral Once V4 core.

Expected verdicts must remain identical to the previously verified V3 lab:

    CASE 1  NAIVE      -> 2 effects -> DUPLICATED
    CASE 2  STABLE     -> 1 effect  -> provider dedupe
    CASE 3  RECONCILE  -> 1 effect  -> CONFIRMED
    CASE 4  UNKNOWN    -> 1 effect  -> BLOCKED
    CASE 4B RECOVERY   -> 1 effect  -> UNKNOWN->CONFIRMED

Durable truth is deliberately split across three independent SQLite files:

    langgraph.sqlite   workflow checkpoint truth
    operations.sqlite  Once logical-operation truth
    provider.sqlite    external-world truth

The protected cases inject a hard process exit *inside the provider adapter*
immediately after provider.sqlite commits the effect and before Once can persist
a receipt. The fresh process therefore has to recover from durable CLAIMED state
by reconciling provider truth.
"""

import argparse
from contextlib import closing
from dataclasses import dataclass
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
from typing import Any, Mapping, TypedDict
import uuid

os.environ.setdefault("LANGGRAPH_STRICT_MSGPACK", "true")

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph

from once_agent.core import (
    ExecutionSource,
    OnceCore,
    OperationRequest,
    OperationState,
    ProviderCapabilities,
    ProviderObservation,
    ProviderTruth,
    UnresolvedOutcome,
    fingerprint_action,
)
from once_agent.storage.sqlite import SQLiteOperationStore


CRASH_EXIT_CODE = 77
UNKNOWN_EXIT_CODE = 78
LEASE_MS = 150
LEASE_SETTLE_SECONDS = 0.30

ORDER_ID = "order_123"
AMOUNT_CENTS = 4200
RECIPIENT = "merchant_7"


class ChargeState(TypedDict, total=False):
    order_id: str
    amount_cents: int
    recipient: str
    payment_key: str
    charged: bool
    effect_id: str
    execution_state: str
    recovery: str


@dataclass(frozen=True)
class ProviderReceipt:
    operation_id: str
    effect_id: str
    order_id: str
    amount_cents: int
    recipient: str
    action_fingerprint: str
    fence_token: int
    deduped: bool = False

    def as_mapping(self) -> dict[str, Any]:
        return {
            "operation_id": self.operation_id,
            "effect_id": self.effect_id,
            "order_id": self.order_id,
            "amount_cents": self.amount_cents,
            "recipient": self.recipient,
            "action_fingerprint": self.action_fingerprint,
            "fence_token": self.fence_token,
            "deduped": self.deduped,
        }


def stable_operation_id(order_id: str) -> str:
    return f"charge:{order_id}"


def action_payload(
    *,
    order_id: str = ORDER_ID,
    amount_cents: int = AMOUNT_CENTS,
    recipient: str = RECIPIENT,
) -> dict[str, Any]:
    return {
        "order_id": order_id,
        "amount_cents": amount_cents,
        "recipient": recipient,
    }


def operation_request(
    *,
    order_id: str = ORDER_ID,
    amount_cents: int = AMOUNT_CENTS,
    recipient: str = RECIPIENT,
) -> OperationRequest:
    payload = action_payload(
        order_id=order_id,
        amount_cents=amount_cents,
        recipient=recipient,
    )
    return OperationRequest(
        operation_id=stable_operation_id(order_id),
        action_fingerprint=fingerprint_action("charge", payload),
        action=payload,
    )


class ProviderLedger:
    """Independent simulated provider and black-box event recorder."""

    capabilities = ProviderCapabilities(
        idempotent_by_operation_id=True,
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
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS effects (
                    effect_id TEXT PRIMARY KEY,
                    operation_id TEXT NOT NULL UNIQUE,
                    action_fingerprint TEXT NOT NULL,
                    order_id TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL,
                    recipient TEXT NOT NULL,
                    fence_token INTEGER NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
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

    def _row_to_receipt(
        self,
        row: sqlite3.Row,
        *,
        deduped: bool,
    ) -> ProviderReceipt:
        return ProviderReceipt(
            operation_id=row["operation_id"],
            effect_id=row["effect_id"],
            order_id=row["order_id"],
            amount_cents=int(row["amount_cents"]),
            recipient=row["recipient"],
            action_fingerprint=row["action_fingerprint"],
            fence_token=int(row["fence_token"]),
            deduped=deduped,
        )

    def _commit_effect(
        self,
        *,
        operation_id: str,
        action_fingerprint: str,
        order_id: str,
        amount_cents: int,
        recipient: str,
        fence_token: int,
    ) -> ProviderReceipt:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            self._log(
                conn,
                "CHARGE_REQUEST",
                operation_id,
                f"order_id={order_id};amount_cents={amount_cents};recipient={recipient}",
            )

            existing = conn.execute(
                """
                SELECT *
                FROM effects
                WHERE operation_id = ?
                """,
                (operation_id,),
            ).fetchone()

            if existing is not None:
                if existing["action_fingerprint"] != action_fingerprint:
                    self._log(
                        conn,
                        "PROVIDER_SEMANTIC_CONFLICT",
                        operation_id,
                        "same operation_id with different action_fingerprint",
                    )
                    conn.execute("COMMIT")
                    raise RuntimeError(
                        "provider operation_id reused with different semantic fingerprint"
                    )

                self._log(
                    conn,
                    "IDEMPOTENT_REPLAY",
                    operation_id,
                    existing["effect_id"],
                )
                conn.execute("COMMIT")
                return self._row_to_receipt(existing, deduped=True)

            next_number = int(
                conn.execute(
                    "SELECT COUNT(*) + 1 AS n FROM effects"
                ).fetchone()["n"]
            )
            effect_id = f"charge_{next_number}"

            conn.execute(
                """
                INSERT INTO effects(
                    effect_id,
                    operation_id,
                    action_fingerprint,
                    order_id,
                    amount_cents,
                    recipient,
                    fence_token
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    effect_id,
                    operation_id,
                    action_fingerprint,
                    order_id,
                    amount_cents,
                    recipient,
                    fence_token,
                ),
            )
            self._log(
                conn,
                "EFFECT_COMMITTED",
                operation_id,
                effect_id,
            )
            conn.execute("COMMIT")

            return ProviderReceipt(
                operation_id=operation_id,
                effect_id=effect_id,
                order_id=order_id,
                amount_cents=amount_cents,
                recipient=recipient,
                action_fingerprint=action_fingerprint,
                fence_token=fence_token,
                deduped=False,
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

        receipt = self._commit_effect(
            operation_id=operation_id,
            action_fingerprint=action_fingerprint,
            order_id=str(action["order_id"]),
            amount_cents=int(action["amount_cents"]),
            recipient=str(action["recipient"]),
            fence_token=fence_token,
        )

        print(
            json.dumps(
                {
                    "phase": "provider_committed",
                    "mode": self.mode,
                    "operation_id": operation_id,
                    "effect_id": receipt.effect_id,
                    "deduped": receipt.deduped,
                    "fence_token": fence_token,
                }
            ),
            flush=True,
        )

        if self.crash_after_commit and not receipt.deduped:
            print(
                json.dumps(
                    {
                        "phase": "hard_crash",
                        "mode": self.mode,
                        "operation_id": operation_id,
                        "effect_id": receipt.effect_id,
                        "exit_code": CRASH_EXIT_CODE,
                        "message": (
                            "provider effect is durable; terminating before Once "
                            "or LangGraph can persist the success receipt"
                        ),
                    }
                ),
                flush=True,
            )
            os._exit(CRASH_EXIT_CODE)

        return receipt.as_mapping()

    def execute_control(
        self,
        *,
        operation_id: str,
        action_fingerprint: str,
        action: Mapping[str, Any],
        crash_after_commit: bool,
    ) -> ProviderReceipt:
        receipt = self._commit_effect(
            operation_id=operation_id,
            action_fingerprint=action_fingerprint,
            order_id=str(action["order_id"]),
            amount_cents=int(action["amount_cents"]),
            recipient=str(action["recipient"]),
            fence_token=0,
        )

        print(
            json.dumps(
                {
                    "phase": "provider_committed",
                    "mode": self.mode,
                    "operation_id": operation_id,
                    "effect_id": receipt.effect_id,
                    "deduped": receipt.deduped,
                }
            ),
            flush=True,
        )

        if crash_after_commit and not receipt.deduped:
            print(
                json.dumps(
                    {
                        "phase": "hard_crash",
                        "mode": self.mode,
                        "operation_id": operation_id,
                        "effect_id": receipt.effect_id,
                        "exit_code": CRASH_EXIT_CODE,
                        "message": (
                            "provider effect is durable; terminating before node "
                            "output can be checkpointed"
                        ),
                    }
                ),
                flush=True,
            )
            os._exit(CRASH_EXIT_CODE)

        return receipt

    def lookup(
        self,
        *,
        operation_id: str,
        action_fingerprint: str,
    ) -> ProviderObservation:
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            self._log(conn, "STATUS_QUERY", operation_id)

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
                    operation_id,
                    "provider truth unavailable",
                )
                conn.execute("COMMIT")
                return ProviderObservation(ProviderTruth.UNKNOWN)

            row = conn.execute(
                """
                SELECT *
                FROM effects
                WHERE operation_id = ?
                """,
                (operation_id,),
            ).fetchone()

            if row is None:
                self._log(
                    conn,
                    "STATUS_ABSENT",
                    operation_id,
                    "authoritative absence",
                )
                conn.execute("COMMIT")
                return ProviderObservation(ProviderTruth.ABSENT)

            if row["action_fingerprint"] != action_fingerprint:
                self._log(
                    conn,
                    "PROVIDER_SEMANTIC_CONFLICT",
                    operation_id,
                    "lookup fingerprint mismatch",
                )
                conn.execute("COMMIT")
                raise RuntimeError(
                    "provider stored effect does not match requested fingerprint"
                )

            receipt = self._row_to_receipt(row, deduped=False)
            self._log(
                conn,
                "STATUS_CONFIRMED",
                operation_id,
                receipt.effect_id,
            )
            conn.execute("COMMIT")
            return ProviderObservation(
                ProviderTruth.CONFIRMED,
                receipt=receipt.as_mapping(),
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
            return int(
                conn.execute(
                    "SELECT COUNT(*) AS n FROM effects"
                ).fetchone()["n"]
            )

    def list_effects(self) -> list[dict[str, Any]]:
        with closing(self._connect()) as conn:
            rows = conn.execute(
                """
                SELECT
                    effect_id,
                    operation_id,
                    action_fingerprint,
                    order_id,
                    amount_cents,
                    recipient,
                    fence_token,
                    created_at
                FROM effects
                ORDER BY rowid
                """
            ).fetchall()
            return [dict(row) for row in rows]

    def list_events(self) -> list[dict[str, Any]]:
        with closing(self._connect()) as conn:
            rows = conn.execute(
                """
                SELECT
                    event_id,
                    event_type,
                    operation_id,
                    detail,
                    created_at
                FROM provider_events
                ORDER BY event_id
                """
            ).fetchall()
            return [dict(row) for row in rows]

    def count_event(self, event_type: str) -> int:
        with closing(self._connect()) as conn:
            return int(
                conn.execute(
                    """
                    SELECT COUNT(*) AS n
                    FROM provider_events
                    WHERE event_type = ?
                    """,
                    (event_type,),
                ).fetchone()["n"]
            )


def make_graph(
    *,
    graph_db: Path,
    provider_db: Path,
    operations_db: Path,
    mode: str,
    crash_after_effect: bool,
):
    provider = ProviderLedger(
        provider_db,
        crash_after_commit=crash_after_effect,
        mode=mode,
    )

    def charge_node(state: ChargeState) -> ChargeState:
        order_id = state["order_id"]
        amount_cents = state["amount_cents"]
        recipient = state["recipient"]
        payload = action_payload(
            order_id=order_id,
            amount_cents=amount_cents,
            recipient=recipient,
        )
        fingerprint = fingerprint_action("charge", payload)

        if mode == "naive":
            operation_id = str(uuid.uuid4())
            receipt = provider.execute_control(
                operation_id=operation_id,
                action_fingerprint=fingerprint,
                action=payload,
                crash_after_commit=crash_after_effect,
            )
            return {
                "payment_key": operation_id,
                "charged": True,
                "effect_id": receipt.effect_id,
                "execution_state": "CONFIRMED",
                "recovery": (
                    "IDEMPOTENT_REPLAY" if receipt.deduped else "EXECUTED"
                ),
            }

        if mode == "stable":
            operation_id = stable_operation_id(order_id)
            receipt = provider.execute_control(
                operation_id=operation_id,
                action_fingerprint=fingerprint,
                action=payload,
                crash_after_commit=crash_after_effect,
            )
            return {
                "payment_key": operation_id,
                "charged": True,
                "effect_id": receipt.effect_id,
                "execution_state": "CONFIRMED",
                "recovery": (
                    "IDEMPOTENT_REPLAY" if receipt.deduped else "EXECUTED"
                ),
            }

        if mode not in {"reconcile", "unknown"}:
            raise ValueError(f"unsupported mode: {mode}")

        store = SQLiteOperationStore(operations_db)
        core = OnceCore(store, lease_ms=LEASE_MS)
        request = operation_request(
            order_id=order_id,
            amount_cents=amount_cents,
            recipient=recipient,
        )
        result = core.execute(request, provider=provider)

        return {
            "payment_key": result.operation_id,
            "charged": True,
            "effect_id": result.receipt["effect_id"],
            "execution_state": result.state.value,
            "recovery": result.source.value,
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
                        "recipient": args.recipient,
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
                raise ValueError(f"unsupported action: {args.action}")

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
        ORDER_ID,
        "--amount-cents",
        str(AMOUNT_CENTS),
        "--recipient",
        RECIPIENT,
    ]
    if crash_after_effect:
        command.append("--crash-after-effect")
    return command


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


def make_paths(root: Path) -> tuple[Path, Path, Path]:
    return (
        root / "langgraph.sqlite",
        root / "provider.sqlite",
        root / "operations.sqlite",
    )


def print_forensics(
    *,
    provider: ProviderLedger,
    operations: SQLiteOperationStore,
) -> None:
    print("\nprovider_events:")
    for event in provider.list_events():
        print(
            f"  {event['event_id']:02d} "
            f"{event['event_type']:<20} "
            f"{event['operation_id'] or '-'} "
            f"{event['detail'] or ''}"
        )

    op_id = stable_operation_id(ORDER_ID)
    events = operations.list_events(op_id)
    if events:
        print("operation_events:")
        for event in events:
            print(
                f"  {event['event_id']:02d} "
                f"{event['event_type']:<27} "
                f"state={event['from_state'] or '-'}->{event['to_state'] or '-'} "
                f"fence={event['fence_token'] if event['fence_token'] is not None else '-'} "
                f"version={event['version'] if event['version'] is not None else '-'}"
            )


def assert_event_sequence(
    store: SQLiteOperationStore,
    operation_id: str,
    expected_subsequence: list[str],
) -> None:
    actual = [
        event["event_type"]
        for event in store.list_events(operation_id)
    ]
    cursor = 0
    for wanted in expected_subsequence:
        try:
            cursor = actual.index(wanted, cursor) + 1
        except ValueError as exc:
            raise AssertionError(
                f"missing operation event {wanted!r}; actual={actual!r}"
            ) from exc


def assert_event_state(
    store: SQLiteOperationStore,
    operation_id: str,
    event_type: str,
    *,
    from_state: str,
    to_state: str,
    occurrence: int = -1,
) -> None:
    matches = [
        event
        for event in store.list_events(operation_id)
        if event["event_type"] == event_type
    ]
    if not matches:
        raise AssertionError(
            f"missing operation event {event_type!r}"
        )
    event = matches[occurrence]
    actual = (event["from_state"], event["to_state"])
    expected = (from_state, to_state)
    if actual != expected:
        raise AssertionError(
            f"event {event_type!r} state mismatch: "
            f"expected={expected!r} actual={actual!r}"
        )


def run_case_naive() -> None:
    with tempfile.TemporaryDirectory(prefix="once-v4-lg-naive-") as tmp:
        root = Path(tmp)
        graph_db, provider_db, operations_db = make_paths(root)
        provider = ProviderLedger(provider_db, mode="naive-audit")
        thread_id = "once-v4-naive"

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

        effects = provider.list_effects()
        assert effects[0]["operation_id"] != effects[1]["operation_id"]

        print("\nCASE 1 RESULT: external_effects=2 verdict=DUPLICATED")


def run_case_stable() -> None:
    with tempfile.TemporaryDirectory(prefix="once-v4-lg-stable-") as tmp:
        root = Path(tmp)
        graph_db, provider_db, operations_db = make_paths(root)
        provider = ProviderLedger(provider_db, mode="stable-audit")
        thread_id = "once-v4-stable"

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

        print("\nCASE 2 RESULT: external_effects=1 verdict=ONE_EXTERNAL_EFFECT")


def wait_for_claim_expiry() -> None:
    time.sleep(LEASE_SETTLE_SECONDS)


def run_case_reconcile() -> None:
    with tempfile.TemporaryDirectory(prefix="once-v4-lg-reconcile-") as tmp:
        root = Path(tmp)
        graph_db, provider_db, operations_db = make_paths(root)
        provider = ProviderLedger(provider_db, mode="reconcile-audit")
        operations = SQLiteOperationStore(operations_db)
        thread_id = "once-v4-reconcile"
        op_id = stable_operation_id(ORDER_ID)

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

        row = operations.get(op_id)
        assert row is not None
        assert row.state == OperationState.CLAIMED

        # The process is dead, but V4 deliberately does not treat process death
        # as authority to steal an unexpired lease. Let the lease expire, then
        # reconcile provider truth before any reacquisition can occur.
        wait_for_claim_expiry()

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

        row = operations.get(op_id)
        assert row is not None
        assert row.state == OperationState.CONFIRMED
        assert row.receipt is not None

        assert_event_sequence(
            operations,
            op_id,
            [
                "CLAIM_ACQUIRED",
                "EXECUTE_STARTED",
                "RECONCILE_STARTED",
                "RECONCILE_CONFIRMED",
            ],
        )

        print_forensics(provider=provider, operations=operations)
        print(
            "\nCASE 3 RESULT: external_effects=1 "
            "recovery=RECONCILED state=CONFIRMED"
        )


def run_case_unknown_then_recover() -> None:
    with tempfile.TemporaryDirectory(prefix="once-v4-lg-unknown-") as tmp:
        root = Path(tmp)
        graph_db, provider_db, operations_db = make_paths(root)
        provider = ProviderLedger(provider_db, mode="unknown-audit")
        operations = SQLiteOperationStore(operations_db)
        thread_id = "once-v4-unknown"
        op_id = stable_operation_id(ORDER_ID)

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

        row = operations.get(op_id)
        assert row is not None
        assert row.state == OperationState.CLAIMED

        wait_for_claim_expiry()
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
        show_process("CASE 4 unknown: provider truth unavailable", blocked)
        assert blocked.returncode == UNKNOWN_EXIT_CODE
        assert provider.effect_count() == 1
        assert provider.count_event("CHARGE_REQUEST") == 1
        assert provider.count_event("STATUS_QUERY") == 1
        assert provider.count_event("STATUS_UNKNOWN") == 1

        row = operations.get(op_id)
        assert row is not None
        assert row.state == OperationState.UNKNOWN

        assert_event_sequence(
            operations,
            op_id,
            [
                "CLAIM_ACQUIRED",
                "EXECUTE_STARTED",
                "RECONCILE_STARTED",
                "OUTCOME_UNKNOWN",
                "RECONCILE_UNKNOWN",
            ],
        )
        assert_event_state(
            operations,
            op_id,
            "OUTCOME_UNKNOWN",
            from_state="CLAIMED",
            to_state="UNKNOWN",
        )
        assert_event_state(
            operations,
            op_id,
            "RECONCILE_UNKNOWN",
            from_state="UNKNOWN",
            to_state="UNKNOWN",
        )

        print_forensics(provider=provider, operations=operations)
        print(
            "\nCASE 4 RESULT: external_effects=1 "
            "state=UNKNOWN verdict=BLOCKED"
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

        row = operations.get(op_id)
        assert row is not None
        assert row.state == OperationState.CONFIRMED
        assert row.receipt is not None

        assert_event_sequence(
            operations,
            op_id,
            [
                "OUTCOME_UNKNOWN",
                "RECONCILE_UNKNOWN",
                "RECONCILE_STARTED",
                "RECONCILE_CONFIRMED",
            ],
        )
        assert_event_state(
            operations,
            op_id,
            "RECONCILE_STARTED",
            from_state="UNKNOWN",
            to_state="UNKNOWN",
            occurrence=-1,
        )
        assert_event_state(
            operations,
            op_id,
            "RECONCILE_CONFIRMED",
            from_state="UNKNOWN",
            to_state="CONFIRMED",
        )

        print_forensics(provider=provider, operations=operations)
        print(
            "\nCASE 4B RESULT: external_effects=1 "
            "transition=UNKNOWN->CONFIRMED recovery=RECONCILED"
        )


def run_supervisor() -> int:
    print("Once V4 LangGraph regression gate")
    print("Framework-neutral core: once_core.py")
    print("LangGraph runtime: real StateGraph + SqliteSaver")
    print()
    print("Three independent durable truths:")
    print("  langgraph.sqlite  = workflow checkpoint truth")
    print("  operations.sqlite = Once logical-operation truth")
    print("  provider.sqlite   = external-world truth")
    print()
    print(
        "Regression requirement: preserve all V3 effect counts and verdicts "
        "while Cases 3/4/4B use the V4 core."
    )

    run_case_naive()
    run_case_stable()
    run_case_reconcile()
    run_case_unknown_then_recover()

    print()
    print("PASS: Once V4 LangGraph regression gate held.")
    print("CASE 1  NAIVE      -> 2 effects -> DUPLICATED")
    print("CASE 2  STABLE     -> 1 effect  -> provider dedupe")
    print("CASE 3  RECONCILE  -> 1 effect  -> CONFIRMED")
    print("CASE 4  UNKNOWN    -> 1 effect  -> BLOCKED")
    print("CASE 4B RECOVERY   -> 1 effect  -> UNKNOWN->CONFIRMED")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Once V4 LangGraph regression gate using the framework-neutral "
            "execution-safety core."
        )
    )
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
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
    parser.add_argument("--graph-db", help=argparse.SUPPRESS)
    parser.add_argument("--provider-db", help=argparse.SUPPRESS)
    parser.add_argument("--operations-db", help=argparse.SUPPRESS)
    parser.add_argument("--thread-id", help=argparse.SUPPRESS)
    parser.add_argument("--order-id", default=ORDER_ID, help=argparse.SUPPRESS)
    parser.add_argument(
        "--amount-cents",
        type=int,
        default=AMOUNT_CENTS,
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--recipient", default=RECIPIENT, help=argparse.SUPPRESS)
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
        raise SystemExit("missing child arguments: " + ", ".join(missing))


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.child:
        validate_child_args(args)
        return run_child(args)
    return run_supervisor()


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

"""
LangGraph hostile-retry lab, Version 2.

This script uses:
- real LangGraph StateGraph execution
- real SqliteSaver persistence
- a separate SQLite provider ledger as external truth
- a hard os._exit(77) crash immediately after the provider commits

Default invocation runs the supervisor, which executes two framework-level
crash/restart scenarios:

1. naive random UUID generated inside the node -> duplicate external effect
2. deterministic business identity + provider-supported idempotency -> one effect

The child mode is intentionally internal. The supervisor launches fresh Python
processes so no in-memory state can survive the simulated crash.
"""

import argparse
from contextlib import closing
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TypedDict

# LangGraph's SQLite checkpoint package recommends strict msgpack mode.
os.environ.setdefault("LANGGRAPH_STRICT_MSGPACK", "true")

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph


CRASH_EXIT_CODE = 77


class ChargeState(TypedDict, total=False):
    order_id: str
    amount_cents: int
    payment_key: str
    charged: bool
    effect_id: str


@dataclass(frozen=True)
class Receipt:
    operation_key: str
    effect_id: str
    order_id: str
    amount_cents: int
    deduped: bool


class ProviderLedger:
    """
    Independent external-world ledger.

    This database is deliberately separate from LangGraph's checkpoint DB.
    It represents the state of the external provider, not what LangGraph thinks
    happened.

    Provider-side idempotency is modeled by UNIQUE(operation_key).
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

    def charge(
        self,
        operation_key: str,
        order_id: str,
        amount_cents: int,
    ) -> Receipt:
        """
        Execute one provider-side charge per operation_key.

        BEGIN IMMEDIATE ensures concurrent contenders serialize before checking
        the unique operation identity.
        """
        conn = self._connect()

        try:
            conn.execute("BEGIN IMMEDIATE")

            existing = conn.execute(
                """
                SELECT effect_id, operation_key, order_id, amount_cents
                FROM effects
                WHERE operation_key = ?
                """,
                (operation_key,),
            ).fetchone()

            if existing is not None:
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

            conn.execute("COMMIT")

            # synchronous=FULL means the provider commit has completed before
            # this function returns. The subsequent os._exit() therefore kills
            # the process after the simulated external effect became durable.
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
                ORDER BY created_at, effect_id
                """
            ).fetchall()

        return [dict(row) for row in rows]


def stable_operation_key(order_id: str) -> str:
    return f"charge:{order_id}"


def make_graph(
    *,
    graph_db: Path,
    provider_db: Path,
    mode: str,
    crash_after_effect: bool,
):
    provider = ProviderLedger(provider_db)

    def charge_node(state: ChargeState) -> ChargeState:
        if mode == "naive":
            # This models the fragile pattern: a generated idempotency key is
            # only returned as node state after the external write succeeds.
            # If the process dies before that return is checkpointed, a retry
            # starts without payment_key and generates a new UUID.
            operation_key = state.get("payment_key") or str(uuid.uuid4())

        elif mode == "stable":
            # This key is derived from business identity that already existed
            # before the node attempt.
            operation_key = stable_operation_key(state["order_id"])

        else:
            raise ValueError(f"unsupported mode: {mode}")

        receipt = provider.charge(
            operation_key=operation_key,
            order_id=state["order_id"],
            amount_cents=state["amount_cents"],
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
            print(
                json.dumps(
                    {
                        "phase": "hard_crash",
                        "exit_code": CRASH_EXIT_CODE,
                        "message": (
                            "provider effect is durable; terminating before "
                            "node output can be checkpointed"
                        ),
                    }
                ),
                flush=True,
            )

            # Intentionally bypass:
            # - exception handlers
            # - finally blocks
            # - context-manager cleanup
            # - normal LangGraph shutdown
            #
            # The OS still closes process file handles, while the already
            # committed provider transaction remains durable.
            os._exit(CRASH_EXIT_CODE)

        return {
            "payment_key": operation_key,
            "charged": True,
            "effect_id": receipt.effect_id,
        }

    builder = StateGraph(ChargeState)
    builder.add_node("charge", charge_node)
    builder.add_edge(START, "charge")
    builder.add_edge("charge", END)

    # The caller owns this context manager because the first invocation may
    # hard-exit from inside the node.
    checkpointer_cm = SqliteSaver.from_conn_string(str(graph_db))
    checkpointer = checkpointer_cm.__enter__()
    graph = builder.compile(checkpointer=checkpointer)

    return graph, checkpointer_cm


def run_child(args: argparse.Namespace) -> int:
    graph_db = Path(args.graph_db).resolve()
    provider_db = Path(args.provider_db).resolve()

    graph_db.parent.mkdir(parents=True, exist_ok=True)
    provider_db.parent.mkdir(parents=True, exist_ok=True)

    config = {
        "configurable": {
            "thread_id": args.thread_id,
        }
    }

    graph, checkpointer_cm = make_graph(
        graph_db=graph_db,
        provider_db=provider_db,
        mode=args.mode,
        crash_after_effect=args.crash_after_effect,
    )

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
            # Resume the persisted LangGraph thread without supplying fresh
            # input. If the prior process died while the node was incomplete,
            # LangGraph should resume from its durable checkpoint state.
            result = graph.invoke(
                None,
                config,
                durability="sync",
            )

        else:
            raise ValueError(f"unsupported child action: {args.action}")

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
        # This executes only on a normal return. os._exit(77) intentionally
        # bypasses it during the hostile crash.
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


def show_process(label: str, result: subprocess.CompletedProcess[str]) -> None:
    print(f"\n--- {label} ---")
    print(f"exit_code={result.returncode}")

    if result.stdout.strip():
        print(result.stdout.rstrip())

    if result.stderr.strip():
        print("[stderr]")
        print(result.stderr.rstrip())


def run_framework_case(mode: str, expected_final_effects: int) -> None:
    with tempfile.TemporaryDirectory(
        prefix=f"once-langgraph-{mode}-"
    ) as tmp:
        root = Path(tmp)
        graph_db = root / "langgraph.sqlite"
        provider_db = root / "provider.sqlite"
        thread_id = f"hostile-retry-{mode}"

        provider = ProviderLedger(provider_db)

        start = run_subprocess(
            child_command(
                action="start",
                mode=mode,
                graph_db=graph_db,
                provider_db=provider_db,
                thread_id=thread_id,
                crash_after_effect=True,
            )
        )

        show_process(f"{mode}: first process", start)

        if start.returncode != CRASH_EXIT_CODE:
            raise AssertionError(
                f"{mode}: expected hard-crash exit code "
                f"{CRASH_EXIT_CODE}, got {start.returncode}"
            )

        after_crash = provider.effect_count()

        if after_crash != 1:
            raise AssertionError(
                f"{mode}: expected exactly 1 durable provider effect "
                f"after crash, got {after_crash}"
            )

        print(
            f"{mode}: provider effects immediately after crash = "
            f"{after_crash}"
        )

        resume = run_subprocess(
            child_command(
                action="resume",
                mode=mode,
                graph_db=graph_db,
                provider_db=provider_db,
                thread_id=thread_id,
                crash_after_effect=False,
            )
        )

        show_process(f"{mode}: fresh-process resume", resume)

        if resume.returncode != 0:
            raise AssertionError(
                f"{mode}: resume process failed with exit code "
                f"{resume.returncode}"
            )

        final_count = provider.effect_count()
        effects = provider.list_effects()

        if final_count != expected_final_effects:
            raise AssertionError(
                f"{mode}: expected {expected_final_effects} external "
                f"effects after resume, got {final_count}. "
                f"effects={effects!r}"
            )

        print(
            json.dumps(
                {
                    "case": mode,
                    "after_crash_effects": after_crash,
                    "final_external_effects": final_count,
                    "effects": effects,
                    "verdict": (
                        "DUPLICATED"
                        if final_count > 1
                        else "ONE_EXTERNAL_EFFECT"
                    ),
                },
                indent=2,
            )
        )


def run_supervisor() -> int:
    print("LangGraph hostile-retry lab — real process restart")
    print(
        "Independent provider truth is stored outside LangGraph's checkpoint DB."
    )
    print(
        f"Hard crash exit code: {CRASH_EXIT_CODE}"
    )

    run_framework_case(
        mode="naive",
        expected_final_effects=2,
    )

    run_framework_case(
        mode="stable",
        expected_final_effects=1,
    )

    print()
    print("PASS: framework-level hostile-retry invariants held.")
    print(
        "NAIVE  -> crash + resume produced 2 external effects."
    )
    print(
        "STABLE -> crash + resume produced 1 external effect "
        "with provider-supported idempotency."
    )

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "LangGraph hostile-retry lab using a real SqliteSaver and "
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
        choices=["naive", "stable"],
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

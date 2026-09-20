from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import json
import os
import sqlite3
import tempfile
import uuid


class CrashAfterEffect(RuntimeError):
    """External side effect committed, but node state was not checkpointed."""


class LostAcknowledgement(RuntimeError):
    """External side effect committed, but the success acknowledgement was lost."""


@dataclass(frozen=True)
class Receipt:
    operation_key: str
    effect_id: str
    order_id: str
    amount_cents: int


class Truth(str, Enum):
    CONFIRMED = "CONFIRMED"
    ABSENT = "ABSENT"
    UNKNOWN = "UNKNOWN"


class MockProvider:
    """
    External system with provider-side idempotency and an authoritative readback.

    charge(key, ...) performs the side effect once per key.
    get_status(key) is the provider-truth query used during reconciliation.
    """

    def __init__(self) -> None:
        self._receipts_by_key: dict[str, Receipt] = {}
        self.effects: list[Receipt] = []
        self.truth_available = True

    def charge(
        self,
        operation_key: str,
        order_id: str,
        amount_cents: int,
    ) -> Receipt:
        existing = self._receipts_by_key.get(operation_key)
        if existing is not None:
            return existing

        receipt = Receipt(
            operation_key=operation_key,
            effect_id=f"charge_{len(self.effects) + 1}",
            order_id=order_id,
            amount_cents=amount_cents,
        )
        self._receipts_by_key[operation_key] = receipt
        self.effects.append(receipt)
        return receipt

    def get_status(
        self,
        operation_key: str,
    ) -> tuple[Truth, Receipt | None]:
        if not self.truth_available:
            return Truth.UNKNOWN, None

        receipt = self._receipts_by_key.get(operation_key)
        if receipt is None:
            return Truth.ABSENT, None

        return Truth.CONFIRMED, receipt


def stable_operation_key(order_id: str) -> str:
    # Stable business identity known before the external side effect.
    return f"charge:{order_id}"


def naive_random_uuid_node(
    checkpoint: dict,
    provider: MockProvider,
    *,
    crash_after_effect: bool,
) -> dict:
    """
    Unsafe pattern:

      random key generated inside node
          ->
      provider side effect
          ->
      key returned in node state

    If the provider succeeds but the process dies before the node returns,
    the generated key never reaches checkpointed state.
    """
    operation_key = checkpoint.get("payment_key") or str(uuid.uuid4())

    receipt = provider.charge(
        operation_key,
        checkpoint["order_id"],
        checkpoint["amount_cents"],
    )

    if crash_after_effect:
        raise CrashAfterEffect(
            "provider succeeded before checkpoint commit"
        )

    return {
        **checkpoint,
        "payment_key": operation_key,
        "charged": True,
        "effect_id": receipt.effect_id,
    }


def deterministic_key_node(
    checkpoint: dict,
    provider: MockProvider,
    *,
    crash_after_effect: bool,
) -> dict:
    operation_key = stable_operation_key(checkpoint["order_id"])

    receipt = provider.charge(
        operation_key,
        checkpoint["order_id"],
        checkpoint["amount_cents"],
    )

    if crash_after_effect:
        raise CrashAfterEffect(
            "provider succeeded before checkpoint commit"
        )

    return {
        **checkpoint,
        "payment_key": operation_key,
        "charged": True,
        "effect_id": receipt.effect_id,
    }


class DurableLedger:
    """Tiny SQLite ledger so local operation state survives layer recreation."""

    def __init__(self, path: str) -> None:
        self.path = path
        with sqlite3.connect(self.path) as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS operations (
                    operation_key TEXT PRIMARY KEY,
                    state TEXT NOT NULL,
                    receipt_json TEXT
                )
                """
            )

    def get(
        self,
        operation_key: str,
    ) -> tuple[str, Receipt | None] | None:
        with sqlite3.connect(self.path) as db:
            row = db.execute(
                """
                SELECT state, receipt_json
                FROM operations
                WHERE operation_key = ?
                """,
                (operation_key,),
            ).fetchone()

        if row is None:
            return None

        state, raw_receipt = row
        receipt = (
            None
            if raw_receipt is None
            else Receipt(**json.loads(raw_receipt))
        )
        return state, receipt

    def claim(self, operation_key: str) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute(
                """
                INSERT OR IGNORE INTO operations(
                    operation_key,
                    state,
                    receipt_json
                )
                VALUES (?, 'CLAIMED', NULL)
                """,
                (operation_key,),
            )

    def settle(
        self,
        operation_key: str,
        receipt: Receipt,
    ) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute(
                """
                INSERT INTO operations(
                    operation_key,
                    state,
                    receipt_json
                )
                VALUES (?, 'CONFIRMED', ?)
                ON CONFLICT(operation_key) DO UPDATE SET
                    state = excluded.state,
                    receipt_json = excluded.receipt_json
                """,
                (
                    operation_key,
                    json.dumps(receipt.__dict__),
                ),
            )

    def mark_unknown(self, operation_key: str) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute(
                """
                INSERT INTO operations(
                    operation_key,
                    state,
                    receipt_json
                )
                VALUES (?, 'UNKNOWN', NULL)
                ON CONFLICT(operation_key) DO UPDATE SET
                    state = 'UNKNOWN'
                """,
                (operation_key,),
            )


@dataclass(frozen=True)
class ExecutionResult:
    state: str
    recovery: str
    receipt: Receipt | None


class SafeExecutionLayer:
    """
    Minimal Once-like recovery model:

      stable identity
        -> durable claim
        -> provider truth
        -> replay / reconcile / execute / UNKNOWN
    """

    def __init__(
        self,
        ledger: DurableLedger,
        provider: MockProvider,
    ) -> None:
        self.ledger = ledger
        self.provider = provider

    def execute(
        self,
        *,
        order_id: str,
        amount_cents: int,
        lose_ack_after_effect: bool = False,
    ) -> ExecutionResult:
        operation_key = stable_operation_key(order_id)
        local = self.ledger.get(operation_key)

        if local is not None and local[0] == "CONFIRMED":
            return ExecutionResult(
                state="CONFIRMED",
                recovery="REPLAYED",
                receipt=local[1],
            )

        if local is not None:
            truth, receipt = self.provider.get_status(operation_key)

            if truth == Truth.CONFIRMED:
                assert receipt is not None
                self.ledger.settle(operation_key, receipt)
                return ExecutionResult(
                    state="CONFIRMED",
                    recovery="RECONCILED",
                    receipt=receipt,
                )

            if truth == Truth.UNKNOWN:
                self.ledger.mark_unknown(operation_key)
                return ExecutionResult(
                    state="UNKNOWN",
                    recovery="BLOCKED",
                    receipt=None,
                )

            # Only authoritative ABSENT permits another execution.

        self.ledger.claim(operation_key)

        receipt = self.provider.charge(
            operation_key,
            order_id,
            amount_cents,
        )

        if lose_ack_after_effect:
            raise LostAcknowledgement(
                "external effect committed; acknowledgement lost "
                "before settlement"
            )

        self.ledger.settle(operation_key, receipt)
        return ExecutionResult(
            state="CONFIRMED",
            recovery="EXECUTED",
            receipt=receipt,
        )


def scenario_1_naive_random_uuid() -> None:
    provider = MockProvider()
    checkpoint = {
        "order_id": "order_123",
        "amount_cents": 4200,
    }

    try:
        naive_random_uuid_node(
            checkpoint,
            provider,
            crash_after_effect=True,
        )
    except CrashAfterEffect:
        pass

    # Retry starts from the unchanged checkpoint.
    result = naive_random_uuid_node(
        checkpoint,
        provider,
        crash_after_effect=False,
    )

    assert len(provider.effects) == 2
    assert (
        provider.effects[0].operation_key
        != provider.effects[1].operation_key
    )

    print(
        "SCENARIO 1  naive-random-uuid  "
        f"external_effects={len(provider.effects)}  "
        "result=DUPLICATED"
    )


def scenario_2_deterministic_identity() -> None:
    provider = MockProvider()
    checkpoint = {
        "order_id": "order_123",
        "amount_cents": 4200,
    }

    try:
        deterministic_key_node(
            checkpoint,
            provider,
            crash_after_effect=True,
        )
    except CrashAfterEffect:
        pass

    result = deterministic_key_node(
        checkpoint,
        provider,
        crash_after_effect=False,
    )

    assert len(provider.effects) == 1
    assert result["payment_key"] == "charge:order_123"

    print(
        "SCENARIO 2  deterministic-identity  "
        f"external_effects={len(provider.effects)}  "
        "result=DEDUPED"
    )


def scenario_3_reconciliation() -> None:
    provider = MockProvider()

    with tempfile.TemporaryDirectory() as tmp:
        ledger_path = os.path.join(tmp, "ledger.sqlite")
        layer = SafeExecutionLayer(
            DurableLedger(ledger_path),
            provider,
        )

        try:
            layer.execute(
                order_id="order_123",
                amount_cents=4200,
                lose_ack_after_effect=True,
            )
        except LostAcknowledgement:
            pass

        assert len(provider.effects) == 1

        # New layer instance models recovery after local restart.
        recovered = SafeExecutionLayer(
            DurableLedger(ledger_path),
            provider,
        )
        result = recovered.execute(
            order_id="order_123",
            amount_cents=4200,
        )

        assert len(provider.effects) == 1
        assert result.state == "CONFIRMED"
        assert result.recovery == "RECONCILED"

        print(
            "SCENARIO 3  ambiguous-ack  "
            f"external_effects={len(provider.effects)}  "
            f"recovery={result.recovery}  "
            f"result={result.state}"
        )


def scenario_4_fail_closed_unknown() -> None:
    provider = MockProvider()

    with tempfile.TemporaryDirectory() as tmp:
        ledger_path = os.path.join(tmp, "ledger.sqlite")
        layer = SafeExecutionLayer(
            DurableLedger(ledger_path),
            provider,
        )

        try:
            layer.execute(
                order_id="order_123",
                amount_cents=4200,
                lose_ack_after_effect=True,
            )
        except LostAcknowledgement:
            pass

        assert len(provider.effects) == 1

        # Provider truth is temporarily unavailable / indeterminate.
        provider.truth_available = False

        recovered = SafeExecutionLayer(
            DurableLedger(ledger_path),
            provider,
        )
        result = recovered.execute(
            order_id="order_123",
            amount_cents=4200,
        )

        assert len(provider.effects) == 1
        assert result.state == "UNKNOWN"
        assert result.recovery == "BLOCKED"

        print(
            "SCENARIO 4  unresolved-provider-truth  "
            f"external_effects={len(provider.effects)}  "
            f"recovery={result.recovery}  "
            f"result={result.state}"
        )


def main() -> None:
    scenario_1_naive_random_uuid()
    scenario_2_deterministic_identity()
    scenario_3_reconciliation()
    scenario_4_fail_closed_unknown()

    print()
    print("PASS: all hostile-retry invariants held.")


if __name__ == "__main__":
    main()

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import json
import os
import sqlite3
import tempfile


class LostAcknowledgement(RuntimeError):
    pass


class PayloadConflict(RuntimeError):
    pass


class Truth(str, Enum):
    CONFIRMED = "CONFIRMED"
    ABSENT = "ABSENT"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class Receipt:
    operation_key: str
    effect_id: str
    order_id: str
    amount_cents: int


class FaultyProvider:
    """Deterministic provider used to inject adversarial retry faults."""

    def __init__(self) -> None:
        self.receipts: dict[str, Receipt] = {}
        self.effects: list[Receipt] = []
        self.truth_available = True
        self.visibility_delay_reads: dict[str, int] = {}

    def charge(self, operation_key: str, order_id: str, amount_cents: int) -> Receipt:
        existing = self.receipts.get(operation_key)
        if existing is not None:
            return existing

        receipt = Receipt(
            operation_key=operation_key,
            effect_id=f"charge_{len(self.effects) + 1}",
            order_id=order_id,
            amount_cents=amount_cents,
        )
        self.receipts[operation_key] = receipt
        self.effects.append(receipt)
        return receipt

    def set_visibility_delay(self, operation_key: str, reads: int) -> None:
        self.visibility_delay_reads[operation_key] = reads

    def get_status(self, operation_key: str) -> tuple[Truth, Receipt | None]:
        if not self.truth_available:
            return Truth.UNKNOWN, None

        remaining = self.visibility_delay_reads.get(operation_key, 0)
        if remaining > 0:
            self.visibility_delay_reads[operation_key] = remaining - 1
            # Delayed visibility is not authoritative absence.
            return Truth.UNKNOWN, None

        receipt = self.receipts.get(operation_key)
        if receipt is None:
            return Truth.ABSENT, None
        return Truth.CONFIRMED, receipt


def stable_operation_key(order_id: str) -> str:
    return f"charge:{order_id}"


def effect_hash(order_id: str, amount_cents: int) -> str:
    raw = json.dumps(
        {"order_id": order_id, "amount_cents": amount_cents},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(raw).hexdigest()


class Ledger:
    def __init__(self, path: str) -> None:
        self.path = path
        with sqlite3.connect(path) as db:
            db.execute(
                """
                CREATE TABLE IF NOT EXISTS operations (
                    operation_key TEXT PRIMARY KEY,
                    state TEXT NOT NULL,
                    effect_hash TEXT NOT NULL,
                    receipt_json TEXT
                )
                """
            )

    def get(self, key: str):
        with sqlite3.connect(self.path) as db:
            return db.execute(
                "SELECT state,effect_hash,receipt_json FROM operations WHERE operation_key=?",
                (key,),
            ).fetchone()

    def claim(self, key: str, ehash: str) -> None:
        with sqlite3.connect(self.path) as db:
            row = db.execute(
                "SELECT effect_hash FROM operations WHERE operation_key=?",
                (key,),
            ).fetchone()
            if row and row[0] != ehash:
                raise PayloadConflict(
                    "same logical identity reused with different effect payload"
                )
            db.execute(
                "INSERT OR IGNORE INTO operations(operation_key,state,effect_hash,receipt_json) "
                "VALUES(?,?,?,NULL)",
                (key, "CLAIMED", ehash),
            )

    def mark_unknown(self, key: str) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute(
                "UPDATE operations SET state='UNKNOWN' WHERE operation_key=?",
                (key,),
            )

    def settle(self, key: str, ehash: str, receipt: Receipt) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute(
                "INSERT INTO operations(operation_key,state,effect_hash,receipt_json) "
                "VALUES(?,?,?,?) "
                "ON CONFLICT(operation_key) DO UPDATE SET "
                "state=excluded.state, receipt_json=excluded.receipt_json",
                (key, "CONFIRMED", ehash, json.dumps(receipt.__dict__)),
            )


@dataclass(frozen=True)
class Result:
    state: str
    recovery: str


class SafeLayer:
    """Small executable model of Once's retry-safety boundary."""

    def __init__(self, ledger: Ledger, provider: FaultyProvider) -> None:
        self.ledger = ledger
        self.provider = provider

    def execute(
        self,
        order_id: str,
        amount_cents: int,
        *,
        lose_ack: bool = False,
    ) -> Result:
        key = stable_operation_key(order_id)
        ehash = effect_hash(order_id, amount_cents)
        local = self.ledger.get(key)

        if local is not None:
            state, stored_hash, _ = local
            if stored_hash != ehash:
                raise PayloadConflict("effect payload drift detected")
            if state == "CONFIRMED":
                return Result("CONFIRMED", "REPLAYED")

            truth, receipt = self.provider.get_status(key)
            if truth == Truth.CONFIRMED:
                assert receipt is not None
                self.ledger.settle(key, ehash, receipt)
                return Result("CONFIRMED", "RECONCILED")
            if truth == Truth.UNKNOWN:
                self.ledger.mark_unknown(key)
                return Result("UNKNOWN", "BLOCKED")
            # Only authoritative ABSENT permits execution.

        self.ledger.claim(key, ehash)
        receipt = self.provider.charge(key, order_id, amount_cents)
        if lose_ack:
            raise LostAcknowledgement(
                "external effect committed; acknowledgement lost"
            )

        self.ledger.settle(key, ehash, receipt)
        return Result("CONFIRMED", "EXECUTED")


def naive_retry(provider: FaultyProvider, order_id: str, amount_cents: int) -> int:
    """Unsafe control: every retry receives a new attempt identity."""

    provider.charge(f"attempt:{order_id}:1", order_id, amount_cents)
    provider.charge(f"attempt:{order_id}:2", order_id, amount_cents)
    return len(provider.effects)


def run() -> None:
    rows: list[tuple[str, int, str]] = []

    # 1. Control: ambiguous acknowledgement + new attempt identity duplicates.
    provider = FaultyProvider()
    effects = naive_retry(provider, "A", 4200)
    assert effects == 2
    rows.append(("control_new_attempt_identity", effects, "DUPLICATED"))

    # 2. Late commit / lost acknowledgement: reconcile to one effect.
    provider = FaultyProvider()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "ledger.sqlite")
        layer = SafeLayer(Ledger(path), provider)
        try:
            layer.execute("B", 4200, lose_ack=True)
        except LostAcknowledgement:
            pass

        result = SafeLayer(Ledger(path), provider).execute("B", 4200)
        assert len(provider.effects) == 1
        assert result.recovery == "RECONCILED"
        rows.append(("late_commit_reconcile", len(provider.effects), result.recovery))

    # 3. Provider truth unavailable: UNKNOWN fails closed.
    provider = FaultyProvider()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "ledger.sqlite")
        layer = SafeLayer(Ledger(path), provider)
        try:
            layer.execute("C", 4200, lose_ack=True)
        except LostAcknowledgement:
            pass

        provider.truth_available = False
        result = SafeLayer(Ledger(path), provider).execute("C", 4200)
        assert len(provider.effects) == 1
        assert result.state == "UNKNOWN"
        rows.append(("truth_unavailable", len(provider.effects), "BLOCKED_UNKNOWN"))

    # 4. Eventual consistency: delayed visibility is UNKNOWN, never ABSENT.
    provider = FaultyProvider()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "ledger.sqlite")
        layer = SafeLayer(Ledger(path), provider)
        try:
            layer.execute("D", 4200, lose_ack=True)
        except LostAcknowledgement:
            pass

        key = stable_operation_key("D")
        provider.set_visibility_delay(key, 2)
        r1 = SafeLayer(Ledger(path), provider).execute("D", 4200)
        r2 = SafeLayer(Ledger(path), provider).execute("D", 4200)
        r3 = SafeLayer(Ledger(path), provider).execute("D", 4200)

        assert r1.state == "UNKNOWN"
        assert r2.state == "UNKNOWN"
        assert r3.recovery == "RECONCILED"
        assert len(provider.effects) == 1
        rows.append(("eventual_consistency", len(provider.effects), "BLOCK_THEN_RECONCILE"))

    # 5. Redelivery: stable identity is replayed rather than executed again.
    provider = FaultyProvider()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "ledger.sqlite")
        layer = SafeLayer(Ledger(path), provider)
        layer.execute("E", 4200)
        r2 = SafeLayer(Ledger(path), provider).execute("E", 4200)
        r3 = SafeLayer(Ledger(path), provider).execute("E", 4200)

        assert len(provider.effects) == 1
        assert r2.recovery == "REPLAYED"
        assert r3.recovery == "REPLAYED"
        rows.append(("redelivery_same_identity", len(provider.effects), "REPLAYED"))

    # 6. Payload drift: same identity with changed effect-bearing data is rejected.
    provider = FaultyProvider()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "ledger.sqlite")
        layer = SafeLayer(Ledger(path), provider)
        layer.execute("F", 4200)

        try:
            layer.execute("F", 4300)
            raise AssertionError("payload drift was not rejected")
        except PayloadConflict:
            pass

        assert len(provider.effects) == 1
        rows.append(("payload_drift", len(provider.effects), "REJECTED"))

    print("scenario                         effects  result")
    print("-" * 64)
    for name, effects, result in rows:
        print(f"{name:31} {effects:7}  {result}")

    print()
    print("PASS: 6/6 adversarial retry invariants held.")


if __name__ == "__main__":
    run()

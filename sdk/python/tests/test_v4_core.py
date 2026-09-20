from __future__ import annotations

import tempfile
from pathlib import Path

from once_agent.core import (
    AmbiguousProviderOutcome,
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


class MockProvider:
    def __init__(self, *, idempotent=True, authoritative_absence=True, fencing=False):
        self.capabilities = ProviderCapabilities(
            idempotent_by_operation_id=idempotent,
            lookup_by_operation_id=True,
            authoritative_absence=authoritative_absence,
            fencing=fencing,
        )
        self.effects = {}
        self.effect_count = 0
        self.ambiguous_next = False

    def execute(self, *, operation_id, action_fingerprint, action, fence_token):
        if self.capabilities.idempotent_by_operation_id and operation_id in self.effects:
            return self.effects[operation_id]["receipt"]
        self.effect_count += 1
        receipt = {"effect_id": f"effect_{self.effect_count}", "operation_id": operation_id, "fence_token": fence_token}
        self.effects[operation_id] = {"fingerprint": action_fingerprint, "receipt": receipt}
        if self.ambiguous_next:
            self.ambiguous_next = False
            raise AmbiguousProviderOutcome("lost ack after provider commit")
        return receipt

    def lookup(self, *, operation_id, action_fingerprint):
        row = self.effects.get(operation_id)
        if row is None:
            return ProviderObservation(ProviderTruth.ABSENT)
        if row["fingerprint"] != action_fingerprint:
            raise RuntimeError("provider semantic mismatch")
        return ProviderObservation(ProviderTruth.CONFIRMED, row["receipt"])


def req(amount=4200):
    action = {"order_id": "order_123", "amount_cents": amount, "recipient": "merchant_7"}
    return OperationRequest("charge:order_123", fingerprint_action("charge", action), action)


def main():
    with tempfile.TemporaryDirectory() as td:
        store = SQLiteOperationStore(Path(td) / "ops.sqlite")
        core = OnceCore(store, lease_ms=60_000)
        provider = MockProvider()
        first = core.execute(req(), provider=provider)
        assert first.source == ExecutionSource.EXECUTED and provider.effect_count == 1
        replay = core.execute(req(), provider=provider)
        assert replay.source == ExecutionSource.REPLAYED and provider.effect_count == 1
        try:
            core.execute(req(8400), provider=provider)
        except OperationConflict:
            pass
        else:
            raise AssertionError("expected OperationConflict")

    with tempfile.TemporaryDirectory() as td:
        store = SQLiteOperationStore(Path(td) / "ops.sqlite")
        core = OnceCore(store, lease_ms=60_000)
        provider = MockProvider()
        provider.ambiguous_next = True
        try:
            core.execute(req(), provider=provider)
        except UnresolvedOutcome:
            pass
        else:
            raise AssertionError("expected UnresolvedOutcome")
        assert store.get(req().operation_id).state == OperationState.UNKNOWN
        assert provider.effect_count == 1

        forensic = [
            event
            for event in store.list_events(req().operation_id)
            if event["event_type"] == "RECONCILE_UNKNOWN"
        ]
        assert forensic, "expected RECONCILE_UNKNOWN forensic event"
        assert forensic[-1]["from_state"] == "UNKNOWN"
        assert forensic[-1]["to_state"] == "UNKNOWN"

        recovered = core.execute(req(), provider=provider)
        assert recovered.source == ExecutionSource.RECONCILED
        assert provider.effect_count == 1

    with tempfile.TemporaryDirectory() as td:
        store = SQLiteOperationStore(Path(td) / "ops.sqlite")
        core = OnceCore(store, lease_ms=60_000)
        provider = MockProvider()
        store.acquire_or_observe(operation_id=req().operation_id, action_fingerprint=req().action_fingerprint, owner_token="other", lease_ms=60_000)
        try:
            core.execute(req(), provider=provider)
        except OperationInFlight:
            pass
        else:
            raise AssertionError("expected OperationInFlight")
        assert provider.effect_count == 0

    with tempfile.TemporaryDirectory() as td:
        clock = {"now": 1_000_000}
        store = SQLiteOperationStore(Path(td) / "ops.sqlite", now_ms=lambda: clock["now"])
        core = OnceCore(store, lease_ms=100)
        provider = MockProvider(idempotent=False, authoritative_absence=True, fencing=False)
        store.acquire_or_observe(operation_id=req().operation_id, action_fingerprint=req().action_fingerprint, owner_token="dead", lease_ms=100)
        clock["now"] += 1000
        try:
            core.execute(req(), provider=provider)
        except UnsafeProviderCapability:
            pass
        else:
            raise AssertionError("expected UnsafeProviderCapability")
        assert provider.effect_count == 0

    print("PASS: Once V4 framework-neutral core smoke tests")
    print("  execute -> CONFIRMED")
    print("  replay -> no second effect")
    print("  semantic drift -> OperationConflict")
    print("  ambiguous ack -> UNKNOWN")
    print("  reconciliation -> CONFIRMED, one effect")
    print("  competing owner -> IN_FLIGHT blocked")
    print("  unsafe lease expiry -> re-execution blocked")


if __name__ == "__main__":
    main()

"""Regressions for logical operation identity versus payload identity."""

import tempfile
import unittest
from pathlib import Path

from once_agent.core import (
    ExecutionSource,
    OnceCore,
    OperationConflict,
    OperationRequest,
    ProviderCapabilities,
    ProviderObservation,
    ProviderTruth,
    fingerprint_action,
)
from once_agent.storage.sqlite import SQLiteOperationStore


class LogicalIdentityBoundaryTest(unittest.TestCase):
    def test_same_payload_can_be_new_work_while_same_identity_cannot_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            store = SQLiteOperationStore(Path(directory) / "ops.db")
            core = OnceCore(store, lease_ms=60_000)

            class Provider:
                capabilities = ProviderCapabilities(
                    idempotent_by_operation_id=False,
                    lookup_by_operation_id=True,
                    authoritative_absence=True,
                    fencing=False,
                )

                def __init__(self):
                    self.effects = {}

                def lookup(self, *, operation_id, action_fingerprint):
                    row = self.effects.get(operation_id)
                    if row is None:
                        return ProviderObservation(ProviderTruth.ABSENT)
                    if row["fingerprint"] != action_fingerprint:
                        raise AssertionError("provider semantic mismatch")
                    return ProviderObservation(
                        ProviderTruth.CONFIRMED,
                        row["receipt"],
                    )

                def execute(
                    self,
                    *,
                    operation_id,
                    action_fingerprint,
                    action,
                    fence_token,
                ):
                    if operation_id in self.effects:
                        raise AssertionError(
                            "Once permitted a duplicate provider execute"
                        )
                    receipt = {
                        "effect_id": f"effect_{len(self.effects) + 1}",
                        "operation_id": operation_id,
                        "fence_token": fence_token,
                    }
                    self.effects[operation_id] = {
                        "fingerprint": action_fingerprint,
                        "receipt": receipt,
                    }
                    return receipt

            provider = Provider()
            payload = {
                "order_id": "order_123",
                "amount_cents": 4200,
                "recipient": "merchant_7",
            }
            fingerprint = fingerprint_action("charge", payload)

            action_a = OperationRequest(
                "charge:admission_a",
                fingerprint,
                payload,
            )
            first = core.execute(action_a, provider=provider)
            self.assertEqual(first.source, ExecutionSource.EXECUTED)
            self.assertEqual(len(provider.effects), 1)

            retry_a = core.execute(action_a, provider=provider)
            self.assertEqual(retry_a.source, ExecutionSource.REPLAYED)
            self.assertEqual(len(provider.effects), 1)
            self.assertEqual(
                retry_a.receipt["effect_id"],
                first.receipt["effect_id"],
            )

            action_b = OperationRequest(
                "charge:admission_b",
                fingerprint,
                payload,
            )
            second = core.execute(action_b, provider=provider)
            self.assertEqual(second.source, ExecutionSource.EXECUTED)
            self.assertEqual(len(provider.effects), 2)
            self.assertNotEqual(
                second.receipt["effect_id"],
                first.receipt["effect_id"],
            )

            drifted_payload = {
                **payload,
                "amount_cents": 8400,
            }
            drifted_a = OperationRequest(
                "charge:admission_a",
                fingerprint_action("charge", drifted_payload),
                drifted_payload,
            )
            with self.assertRaises(OperationConflict):
                core.execute(drifted_a, provider=provider)

            self.assertEqual(
                len(provider.effects),
                2,
                "semantic drift must fail before another provider effect",
            )


if __name__ == "__main__":
    unittest.main()

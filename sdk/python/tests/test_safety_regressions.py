"""Offline regressions for consequential recovery boundaries."""
import tempfile
import threading
import unittest
from pathlib import Path

from once_agent.core import (
    AmbiguousProviderOutcome, OnceCore, OperationRequest,
    ProviderCapabilities, ProviderObservation, ProviderTruth, UnsafeProviderCapability,
)
from once_agent.storage.sqlite import SQLiteOperationStore


class FencingOnlyRecoveryTest(unittest.TestCase):
    def test_monotonic_fencing_cannot_make_absent_lookup_atomic_with_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = [1000]
            store = SQLiteOperationStore(Path(directory) / 'ops.db', now_ms=lambda: clock[0])
            entered, release, committed = (threading.Event() for _ in range(3))
            errors = []

            class Provider:
                capabilities = ProviderCapabilities(lookup_by_operation_id=True, authoritative_absence=True, fencing=True)
                effects = 0
                highest_fence = 0

                def lookup(self, **kwargs):
                    self_test.assertEqual(self.effects, 0)
                    return ProviderObservation(ProviderTruth.ABSENT)

                def execute(self, *, fence_token, **kwargs):
                    if fence_token == 1:
                        entered.set()
                        if not release.wait(5):
                            raise AssertionError('old caller was not released')
                    else:
                        # The old dispatch arrives after ABSENT + reacquisition,
                        # but before the higher fence reaches the provider.
                        release.set()
                        if not committed.wait(5):
                            raise AssertionError('old dispatch did not commit')
                    if fence_token <= self.highest_fence:
                        raise AssertionError('provider rejected a stale fence')
                    self.highest_fence = fence_token
                    self.effects += 1
                    if fence_token == 1:
                        committed.set()
                        raise AmbiguousProviderOutcome('ack lost')
                    return {'effect': self.effects}

            self_test = self
            provider = Provider()
            request = OperationRequest('refund:one', 'fixed-fingerprint', {})

            def old_caller():
                try:
                    OnceCore(store, lease_ms=10).execute(request, provider=provider)
                except Exception as error:
                    errors.append(error)

            thread = threading.Thread(target=old_caller)
            thread.start()
            try:
                self.assertTrue(entered.wait(5))
                clock[0] += 100
                blocked = False
                try:
                    OnceCore(store, lease_ms=10).execute(request, provider=provider)
                except UnsafeProviderCapability:
                    blocked = True
            finally:
                release.set()
                thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(provider.effects, 1, 'monotonic fencing permitted duplicate effects')
            self.assertTrue(blocked, 'fencing alone must not authorize redispatch')
            self.assertEqual(len(errors), 1)


if __name__ == '__main__':
    unittest.main()

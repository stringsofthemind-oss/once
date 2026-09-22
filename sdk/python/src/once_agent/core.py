from __future__ import annotations

"""Framework-neutral execution-safety core for Once V4.

Separates:
- business identity: operation_id
- semantic identity: action_fingerprint
- execution ownership: owner_token / lease / fence_token
- external reality: provider CONFIRMED / ABSENT / UNKNOWN

UNKNOWN never directly authorizes another write. Re-execution after ambiguity requires
an authoritative provider ABSENT result, compare-and-swap reacquisition, and
provider-side idempotency. Monotonic fencing alone cannot prevent an earlier
in-flight request from committing before the newer fence reaches the provider.
"""

from dataclasses import dataclass
from enum import Enum
import hashlib
import json
from typing import Any, Callable, Mapping, Optional, Protocol, runtime_checkable
import uuid


class OperationState(str, Enum):
    CLAIMED = "CLAIMED"
    CONFIRMED = "CONFIRMED"
    UNKNOWN = "UNKNOWN"


class ProviderTruth(str, Enum):
    CONFIRMED = "CONFIRMED"
    ABSENT = "ABSENT"
    UNKNOWN = "UNKNOWN"


class ExecutionSource(str, Enum):
    EXECUTED = "EXECUTED"
    REPLAYED = "REPLAYED"
    RECONCILED = "RECONCILED"


class AcquireDisposition(str, Enum):
    ACQUIRED = "ACQUIRED"
    REPLAY = "REPLAY"
    RECONCILE = "RECONCILE"
    IN_FLIGHT = "IN_FLIGHT"


class OnceCoreError(RuntimeError):
    pass


class OperationConflict(OnceCoreError):
    pass


class OperationInFlight(OnceCoreError):
    pass


class UnresolvedOutcome(OnceCoreError):
    pass


class UnsafeProviderCapability(OnceCoreError):
    pass


class ExecutionRightLost(OnceCoreError):
    pass


class ConcurrentModification(OnceCoreError):
    pass


class AmbiguousProviderOutcome(Exception):
    """Provider may have committed, but acknowledgement was not definitive."""


@dataclass(frozen=True)
class OperationRequest:
    operation_id: str
    action_fingerprint: str
    action: Any


@dataclass(frozen=True)
class OperationRecord:
    operation_id: str
    action_fingerprint: str
    state: OperationState
    receipt: Optional[dict[str, Any]]
    owner_token: Optional[str]
    lease_until_ms: Optional[int]
    fence_token: int
    version: int
    created_at_ms: int
    updated_at_ms: int


@dataclass(frozen=True)
class AcquireResult:
    disposition: AcquireDisposition
    record: OperationRecord


@dataclass(frozen=True)
class ExecutionResult:
    operation_id: str
    action_fingerprint: str
    state: OperationState
    source: ExecutionSource
    receipt: dict[str, Any]
    fence_token: int


@dataclass(frozen=True)
class ProviderCapabilities:
    # Must cover concurrent dispatches and the entire supported retry horizon.
    # An expired provider key is not an idempotency guarantee.
    idempotent_by_operation_id: bool = False
    lookup_by_operation_id: bool = False
    authoritative_absence: bool = False
    fencing: bool = False


@dataclass(frozen=True)
class ProviderObservation:
    truth: ProviderTruth
    receipt: Optional[dict[str, Any]] = None


def fingerprint_action(action_type: str, payload: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        {"v": 1, "action_type": action_type, "payload": payload},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@runtime_checkable
class ProviderAdapter(Protocol):
    capabilities: ProviderCapabilities

    def execute(
        self,
        *,
        operation_id: str,
        action_fingerprint: str,
        action: Any,
        fence_token: int,
    ) -> dict[str, Any]: ...

    def lookup(
        self,
        *,
        operation_id: str,
        action_fingerprint: str,
    ) -> ProviderObservation: ...


@runtime_checkable
class OperationStore(Protocol):
    def acquire_or_observe(self, *, operation_id: str, action_fingerprint: str, owner_token: str, lease_ms: int) -> AcquireResult: ...
    def reacquire_after_absent(self, *, operation_id: str, action_fingerprint: str, expected_version: int, owner_token: str, lease_ms: int) -> OperationRecord: ...
    def renew_claim(self, *, operation_id: str, action_fingerprint: str, expected_version: int, owner_token: str, fence_token: int, lease_ms: int) -> OperationRecord: ...
    def assert_execution_right(self, *, operation_id: str, action_fingerprint: str, expected_version: int, owner_token: str, fence_token: int) -> OperationRecord: ...
    def mark_unknown(self, *, operation_id: str, action_fingerprint: str, expected_version: int, detail: Optional[Mapping[str, Any]] = None) -> OperationRecord: ...
    def confirm(self, *, operation_id: str, action_fingerprint: str, receipt: Mapping[str, Any], expected_version: int, source: ExecutionSource, owner_token: Optional[str] = None, fence_token: Optional[int] = None) -> OperationRecord: ...
    def get(self, operation_id: str) -> Optional[OperationRecord]: ...
    def append_event(self, *, operation_id: str, event_type: str, record: Optional[OperationRecord] = None, from_state: Optional[OperationState] = None, to_state: Optional[OperationState] = None, detail: Optional[Mapping[str, Any]] = None) -> None: ...



class OnceCore:
    def __init__(self, store: OperationStore, *, lease_ms: int = 30_000, owner_token_factory: Optional[Callable[[], str]] = None) -> None:
        if lease_ms <= 0:
            raise ValueError("lease_ms must be positive")
        self.store = store
        self.lease_ms = lease_ms
        self._owner_token_factory = owner_token_factory or (lambda: uuid.uuid4().hex)

    def execute(self, request: OperationRequest, *, provider: ProviderAdapter) -> ExecutionResult:
        if not request.operation_id or not request.action_fingerprint:
            raise ValueError("operation_id and action_fingerprint are required")
        owner_token = self._owner_token_factory()

        while True:
            decision = self.store.acquire_or_observe(
                operation_id=request.operation_id,
                action_fingerprint=request.action_fingerprint,
                owner_token=owner_token,
                lease_ms=self.lease_ms,
            )

            if decision.disposition == AcquireDisposition.REPLAY:
                if decision.record.receipt is None:
                    raise RuntimeError("CONFIRMED operation missing receipt")
                return ExecutionResult(
                    decision.record.operation_id,
                    decision.record.action_fingerprint,
                    decision.record.state,
                    ExecutionSource.REPLAYED,
                    decision.record.receipt,
                    decision.record.fence_token,
                )

            if decision.disposition == AcquireDisposition.IN_FLIGHT:
                raise OperationInFlight(f"operation {request.operation_id!r} is owned by another live invocation")

            if decision.disposition == AcquireDisposition.ACQUIRED:
                return self._execute_owned(request, provider, decision.record)

            try:
                return self._reconcile(request, provider, decision.record, owner_token)
            except ConcurrentModification:
                continue

    def _reconcile(self, request: OperationRequest, provider: ProviderAdapter, observed: OperationRecord, owner_token: str) -> ExecutionResult:
        self.store.append_event(operation_id=request.operation_id, event_type="RECONCILE_STARTED", record=observed, from_state=observed.state, to_state=observed.state)

        if not provider.capabilities.lookup_by_operation_id:
            unknown = self.store.mark_unknown(
                operation_id=request.operation_id,
                action_fingerprint=request.action_fingerprint,
                expected_version=observed.version,
                detail={"reason": "provider_has_no_lookup_capability"},
            )
            self.store.append_event(operation_id=request.operation_id, event_type="RECONCILE_UNKNOWN", record=unknown, from_state=OperationState.UNKNOWN, to_state=OperationState.UNKNOWN)
            raise UnresolvedOutcome("provider cannot reconcile this operation")

        observation = provider.lookup(operation_id=request.operation_id, action_fingerprint=request.action_fingerprint)

        if observation.truth == ProviderTruth.CONFIRMED:
            if observation.receipt is None:
                raise UnsafeProviderCapability("CONFIRMED provider truth requires a receipt")
            rec = self.store.confirm(
                operation_id=request.operation_id,
                action_fingerprint=request.action_fingerprint,
                receipt=observation.receipt,
                expected_version=observed.version,
                source=ExecutionSource.RECONCILED,
            )
            return ExecutionResult(rec.operation_id, rec.action_fingerprint, rec.state, ExecutionSource.RECONCILED, rec.receipt or {}, rec.fence_token)

        if observation.truth == ProviderTruth.UNKNOWN:
            unknown = self.store.mark_unknown(
                operation_id=request.operation_id,
                action_fingerprint=request.action_fingerprint,
                expected_version=observed.version,
                detail={"reason": "provider_truth_unknown"},
            )
            self.store.append_event(operation_id=request.operation_id, event_type="RECONCILE_UNKNOWN", record=unknown, from_state=OperationState.UNKNOWN, to_state=OperationState.UNKNOWN)
            raise UnresolvedOutcome("provider truth remains UNKNOWN; refusing another write")

        if observation.truth != ProviderTruth.ABSENT or observation.receipt is not None:
            raise UnsafeProviderCapability("invalid provider ABSENT observation")

        if not provider.capabilities.authoritative_absence:
            unknown = self.store.mark_unknown(
                operation_id=request.operation_id,
                action_fingerprint=request.action_fingerprint,
                expected_version=observed.version,
                detail={"reason": "non_authoritative_absence"},
            )
            self.store.append_event(operation_id=request.operation_id, event_type="UNSAFE_REEXECUTION_BLOCKED", record=unknown, from_state=observed.state, to_state=OperationState.UNKNOWN)
            raise UnsafeProviderCapability("provider ABSENT result is not authoritative")

        self.store.append_event(operation_id=request.operation_id, event_type="RECONCILE_ABSENT", record=observed, from_state=observed.state, to_state=observed.state)
        try:
            self._require_safe_reexecution(provider.capabilities)
        except UnsafeProviderCapability:
            self.store.append_event(operation_id=request.operation_id, event_type="UNSAFE_REEXECUTION_BLOCKED", record=observed, from_state=observed.state, to_state=observed.state, detail={"reason": "provider_lacks_idempotency_or_fencing"})
            raise
        claim = self.store.reacquire_after_absent(
            operation_id=request.operation_id,
            action_fingerprint=request.action_fingerprint,
            expected_version=observed.version,
            owner_token=owner_token,
            lease_ms=self.lease_ms,
        )
        return self._execute_owned(request, provider, claim)

    def _execute_owned(self, request: OperationRequest, provider: ProviderAdapter, record: OperationRecord) -> ExecutionResult:
        if record.owner_token is None:
            raise ExecutionRightLost("CLAIMED record missing owner token")
        current = self.store.assert_execution_right(
            operation_id=request.operation_id,
            action_fingerprint=request.action_fingerprint,
            expected_version=record.version,
            owner_token=record.owner_token,
            fence_token=record.fence_token,
        )
        self.store.append_event(operation_id=request.operation_id, event_type="EXECUTE_STARTED", record=current, from_state=OperationState.CLAIMED, to_state=OperationState.CLAIMED)

        try:
            receipt = provider.execute(
                operation_id=request.operation_id,
                action_fingerprint=request.action_fingerprint,
                action=request.action,
                fence_token=current.fence_token,
            )
        except AmbiguousProviderOutcome as exc:
            unknown = self.store.mark_unknown(
                operation_id=request.operation_id,
                action_fingerprint=request.action_fingerprint,
                expected_version=current.version,
                detail={"reason": "ambiguous_provider_outcome", "message": str(exc)},
            )
            self.store.append_event(operation_id=request.operation_id, event_type="RECONCILE_UNKNOWN", record=unknown, from_state=OperationState.UNKNOWN, to_state=OperationState.UNKNOWN)
            raise UnresolvedOutcome("provider may have committed, but acknowledgement was ambiguous") from exc

        if not isinstance(receipt, Mapping):
            raise TypeError("provider.execute() must return a mapping receipt")

        try:
            rec = self.store.confirm(
                operation_id=request.operation_id,
                action_fingerprint=request.action_fingerprint,
                receipt=dict(receipt),
                expected_version=current.version,
                source=ExecutionSource.EXECUTED,
                owner_token=current.owner_token,
                fence_token=current.fence_token,
            )
        except ExecutionRightLost:
            self.store.append_event(operation_id=request.operation_id, event_type="EXECUTION_RIGHT_LOST", record=self.store.get(request.operation_id), detail={"phase": "post_provider_pre_confirm", "fence_token": current.fence_token})
            raise

        return ExecutionResult(rec.operation_id, rec.action_fingerprint, rec.state, ExecutionSource.EXECUTED, rec.receipt or {}, rec.fence_token)

    @staticmethod
    def _require_safe_reexecution(capabilities: ProviderCapabilities) -> None:
        if capabilities.idempotent_by_operation_id:
            return
        raise UnsafeProviderCapability(
            "redispatch requires provider idempotency by operation_id; ABSENT and monotonic fencing alone cannot exclude an earlier in-flight effect"
        )

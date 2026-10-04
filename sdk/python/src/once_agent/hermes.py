from __future__ import annotations

"""Hermes tool-execution middleware adapter for the Once framework-neutral core.

Hermes execution middleware is fail-open when a middleware callback raises before
calling ``next_call``. Consequential Once-protected tool calls therefore must
return an intentional tool result for safety failures rather than let those
failures escape into Hermes' middleware fallback path.

This adapter is intentionally narrow:
- the host supplies stable logical operation identity;
- the effective Hermes tool arguments are fully bound into the action fingerprint;
- model/tool call IDs remain metadata unless the host explicitly promotes them;
- provider reconciliation is explicit and authoritative-provider specific;
- UNKNOWN, conflict, state failure, or reconciliation failure short-circuits
  without calling ``next_call`` again.
"""

from dataclasses import dataclass
import json
from typing import Any, Callable, Dict, Mapping, Optional

from .core import (
    AmbiguousProviderOutcome,
    OnceCore,
    OperationConflict,
    OperationInFlight,
    OperationRequest,
    ProviderCapabilities,
    ProviderObservation,
    ProviderTruth,
    UnsafeProviderCapability,
    UnresolvedOutcome,
    fingerprint_action,
)


OperationIdResolver = Callable[[str, Mapping[str, Any], Mapping[str, Any]], Optional[str]]
BlockedResultFactory = Callable[[str, BaseException], Any]


@dataclass(frozen=True)
class HermesLookupResult:
    """Provider truth for one previously dispatched Hermes tool effect."""

    truth: ProviderTruth
    result: Any = None


def _default_blocked_result(tool_name: str, exc: BaseException) -> str:
    if isinstance(exc, OperationConflict):
        code = "once_operation_conflict"
    elif isinstance(exc, OperationInFlight):
        code = "once_operation_in_flight"
    elif isinstance(exc, UnresolvedOutcome):
        code = "once_outcome_unknown"
    elif isinstance(exc, UnsafeProviderCapability):
        code = "once_unsafe_redispatch_blocked"
    else:
        code = "once_safety_blocked"

    return json.dumps(
        {
            "ok": False,
            "tool": tool_name,
            "code": code,
            "message": "Once blocked this consequential tool call because safe execution could not be proven.",
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _receipt_for_result(result: Any) -> Dict[str, Any]:
    receipt = {"hermes_result": result}
    try:
        json.dumps(receipt, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise AmbiguousProviderOutcome(
            "tool execution returned a non-JSON-safe result after dispatch"
        ) from exc
    return receipt


class _HermesCallbackProvider:
    def __init__(
        self,
        *,
        tool_name: str,
        args: Mapping[str, Any],
        context: Mapping[str, Any],
        next_call: Callable[[Dict[str, Any]], Any],
        reconcile: Optional[
            Callable[
                [str, str, Mapping[str, Any], Mapping[str, Any]],
                HermesLookupResult,
            ]
        ],
        idempotent_by_operation_id: bool,
        authoritative_absence: bool,
    ) -> None:
        self._tool_name = tool_name
        self._args = dict(args)
        self._context = dict(context)
        self._next_call = next_call
        self._reconcile = reconcile
        self.capabilities = ProviderCapabilities(
            idempotent_by_operation_id=idempotent_by_operation_id,
            lookup_by_operation_id=reconcile is not None,
            authoritative_absence=authoritative_absence,
            fencing=False,
        )

    def execute(
        self,
        *,
        operation_id: str,
        action_fingerprint: str,
        action: Any,
        fence_token: int,
    ) -> Dict[str, Any]:
        del operation_id, action_fingerprint, action, fence_token
        try:
            result = self._next_call(dict(self._args))
        except Exception as exc:
            # For a consequential callback, an exception after dispatch is
            # conservatively ambiguous unless provider-specific code proves it
            # was pre-effect. Mark UNKNOWN rather than allow Hermes to fall
            # through and call the underlying tool again.
            raise AmbiguousProviderOutcome(
                "Hermes tool execution failed after dispatch; external outcome is uncertain"
            ) from exc
        return _receipt_for_result(result)

    def lookup(
        self,
        *,
        operation_id: str,
        action_fingerprint: str,
    ) -> ProviderObservation:
        if self._reconcile is None:
            return ProviderObservation(ProviderTruth.UNKNOWN)

        observation = self._reconcile(
            operation_id,
            action_fingerprint,
            dict(self._args),
            dict(self._context),
        )
        if not isinstance(observation, HermesLookupResult):
            raise TypeError("Hermes reconcile callback must return HermesLookupResult")

        if observation.truth == ProviderTruth.CONFIRMED:
            return ProviderObservation(
                ProviderTruth.CONFIRMED,
                _receipt_for_result(observation.result),
            )
        if observation.truth not in {ProviderTruth.ABSENT, ProviderTruth.UNKNOWN}:
            raise ValueError("Hermes reconciliation returned unsupported provider truth")
        if observation.result is not None:
            raise ValueError("ABSENT/UNKNOWN reconciliation must not include a result")
        return ProviderObservation(observation.truth)


def make_hermes_tool_execution_middleware(
    *,
    core: OnceCore,
    operation_id: OperationIdResolver,
    reconcile: Optional[
        Callable[
            [str, str, Mapping[str, Any], Mapping[str, Any]],
            HermesLookupResult,
        ]
    ] = None,
    provider_idempotent_by_operation_id: bool = False,
    authoritative_absence: bool = False,
    blocked_result: BlockedResultFactory = _default_blocked_result,
) -> Callable[..., Any]:
    """Create a Hermes ``tool_execution`` middleware callback.

    ``operation_id`` returns a stable business/logical operation identifier for
    tools that must be protected, or ``None`` to bypass Once for that tool.
    The resolver receives ``(tool_name, args, context)``. The context contains
    Hermes metadata such as session/task/turn/tool-call IDs, but callers should
    not treat a transport/model tool-call ID as durable business identity unless
    their own contract guarantees it.

    For protected calls, all effective ``args`` plus ``tool_name`` are included
    in the Once action fingerprint. Reusing an operation ID with different
    effect-bearing input therefore conflicts before dispatch.

    Safety failures return a normal middleware result. This is deliberate:
    Hermes treats an exception raised before ``next_call`` as middleware failure
    and continues to the next middleware/base tool. Returning a blocked result
    is what prevents fail-open fallback from bypassing Once.
    """

    if not isinstance(core, OnceCore):
        raise TypeError("core must be an OnceCore instance")
    if not callable(operation_id):
        raise TypeError("operation_id must be callable")
    if reconcile is not None and not callable(reconcile):
        raise TypeError("reconcile must be callable")
    if not callable(blocked_result):
        raise TypeError("blocked_result must be callable")

    def render_blocked(tool_name: str, exc: BaseException) -> Any:
        try:
            return blocked_result(tool_name, exc)
        except Exception:
            # A custom blocked-result formatter is still inside Hermes'
            # fail-open boundary. Never let its own failure become permission to
            # continue to the base tool.
            return _default_blocked_result(tool_name, exc)

    def middleware(**kwargs: Any) -> Any:
        raw_tool_name = kwargs.get("tool_name")
        tool_name = raw_tool_name if isinstance(raw_tool_name, str) else ""
        raw_args = kwargs.get("args")
        next_call = kwargs.get("next_call")

        if not tool_name or not isinstance(raw_args, Mapping) or not callable(next_call):
            return render_blocked(
                tool_name or "<unknown>",
                ValueError("invalid Hermes middleware payload"),
            )

        try:
            args = dict(raw_args)
            context = {
                key: value
                for key, value in kwargs.items()
                if key not in {"args", "original_args", "next_call"}
            }
            logical_id = operation_id(tool_name, args, context)
        except Exception as exc:
            return render_blocked(tool_name, exc)

        if logical_id is None:
            # Explicit bypass: this tool is outside the protected set.
            return next_call(args)

        try:
            if not isinstance(logical_id, str) or not logical_id:
                raise ValueError(
                    "protected Hermes tool requires a non-empty logical operation ID"
                )

            action = {
                "tool_name": tool_name,
                "args": args,
            }
            request = OperationRequest(
                operation_id=logical_id,
                action_fingerprint=fingerprint_action("hermes_tool_call", action),
                action=action,
            )
            provider = _HermesCallbackProvider(
                tool_name=tool_name,
                args=args,
                context=context,
                next_call=next_call,
                reconcile=reconcile,
                idempotent_by_operation_id=provider_idempotent_by_operation_id,
                authoritative_absence=authoritative_absence,
            )
            result = core.execute(request, provider=provider)
            if "hermes_result" not in result.receipt:
                raise RuntimeError("Once receipt missing Hermes tool result")
            return result.receipt["hermes_result"]
        except Exception as exc:
            # Critical Hermes-specific boundary: every protected pre-dispatch,
            # storage, reconciliation, and ambiguous-outcome failure becomes an
            # intentional return value. A raised exception here would make
            # Hermes continue to the next middleware/base tool.
            return render_blocked(tool_name, exc)

    return middleware


__all__ = [
    "HermesLookupResult",
    "make_hermes_tool_execution_middleware",
]

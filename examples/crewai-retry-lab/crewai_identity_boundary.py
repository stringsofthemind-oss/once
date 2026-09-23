from __future__ import annotations

"""CrewAI regression for logical operation identity versus payload identity."""

import asyncio
import tempfile
from pathlib import Path
from typing import Any

from crewai.tools import BaseTool, ToolFailure
from pydantic import PrivateAttr

# Importing the existing lab also installs the local SDK source path.
from crewai_v4_regression import ProviderLedger

from once_agent.core import (
    OnceCore,
    OperationConflict,
    OperationRequest,
    fingerprint_action,
)
from once_agent.storage.sqlite import SQLiteOperationStore


PAYLOAD = {
    "order_id": "order_123",
    "amount_cents": 4200,
    "recipient": "merchant_7",
}
OPERATION_A = "charge:admission_a"
OPERATION_B = "charge:admission_b"


class ExplicitIdentityChargeTool(BaseTool):
    """CrewAI adapter that requires a pre-minted logical operation identity."""

    name: str = "send_payment_with_operation_id"
    description: str = (
        "Send one payment using a logical operation ID minted before execution."
    )

    _core: OnceCore = PrivateAttr()
    _provider: ProviderLedger = PrivateAttr()

    def __init__(
        self,
        *,
        core: OnceCore,
        provider: ProviderLedger,
        **data: Any,
    ) -> None:
        super().__init__(**data)
        self._core = core
        self._provider = provider

    def _run(
        self,
        operation_id: str,
        order_id: str,
        amount_cents: int,
        recipient: str,
    ) -> Any:
        payload = {
            "order_id": order_id,
            "amount_cents": amount_cents,
            "recipient": recipient,
        }
        request = OperationRequest(
            operation_id=operation_id,
            action_fingerprint=fingerprint_action("charge", payload),
            action=payload,
        )

        try:
            result = self._core.execute(
                request,
                provider=self._provider,
            )
        except OperationConflict:
            return ToolFailure(
                message=(
                    "The logical operation identity was reused with different "
                    "action semantics."
                ),
                code="once_operation_conflict",
                retryable=False,
            )

        return {
            "operation_id": result.operation_id,
            "effect_id": result.receipt["effect_id"],
            "execution_state": result.state.value,
            "recovery": result.source.value,
        }


async def invoke(
    tool: BaseTool,
    *,
    operation_id: str,
    payload: dict[str, Any],
) -> Any:
    structured = tool.to_structured_tool()
    return await structured.ainvoke(
        input={
            "operation_id": operation_id,
            **payload,
        }
    )


def require_result(result: Any, label: str) -> dict[str, Any]:
    if isinstance(result, ToolFailure):
        raise AssertionError(
            f"{label}: expected success, got {result.code}: {result.message}"
        )
    if not isinstance(result, dict):
        raise AssertionError(
            f"{label}: expected dict result, got {type(result).__name__}"
        )
    return result


def main() -> int:
    print("Once CrewAI logical identity boundary regression")
    print(
        "Invariant: logical operation identity defines replay; "
        "payload equality alone does not."
    )

    with tempfile.TemporaryDirectory(
        prefix="once-crewai-identity-"
    ) as directory:
        root = Path(directory)
        provider = ProviderLedger(root / "provider.sqlite")
        store = SQLiteOperationStore(root / "operations.sqlite")
        core = OnceCore(store, lease_ms=60_000)
        tool = ExplicitIdentityChargeTool(
            core=core,
            provider=provider,
        )

        first_a = require_result(
            asyncio.run(
                invoke(
                    tool,
                    operation_id=OPERATION_A,
                    payload=PAYLOAD,
                )
            ),
            "A first execution",
        )
        if provider.effect_count() != 1:
            raise AssertionError("A first execution must create one effect")
        print(
            "CASE D1 A execute        -> "
            f"effects=1 recovery={first_a['recovery']}"
        )

        retry_a = require_result(
            asyncio.run(
                invoke(
                    tool,
                    operation_id=OPERATION_A,
                    payload=PAYLOAD,
                )
            ),
            "A retry",
        )
        if provider.effect_count() != 1:
            raise AssertionError("A retry created a duplicate effect")
        if retry_a["effect_id"] != first_a["effect_id"]:
            raise AssertionError("A retry did not replay the original receipt")
        print(
            "CASE D2 A retry          -> "
            f"effects=1 recovery={retry_a['recovery']}"
        )

        first_b = require_result(
            asyncio.run(
                invoke(
                    tool,
                    operation_id=OPERATION_B,
                    payload=PAYLOAD,
                )
            ),
            "B intentional execution",
        )
        if provider.effect_count() != 2:
            raise AssertionError(
                "B is new logical work and must create a second effect"
            )
        if first_b["effect_id"] == first_a["effect_id"]:
            raise AssertionError("A and B must have distinct provider effects")
        print(
            "CASE D3 identical B      -> "
            f"effects=2 recovery={first_b['recovery']}"
        )

        drifted_payload = {
            **PAYLOAD,
            "amount_cents": 8400,
        }
        drifted_a = asyncio.run(
            invoke(
                tool,
                operation_id=OPERATION_A,
                payload=drifted_payload,
            )
        )
        if not isinstance(drifted_a, ToolFailure):
            raise AssertionError(
                "drifted A must fail closed as an operation conflict"
            )
        if drifted_a.code != "once_operation_conflict":
            raise AssertionError(
                f"drifted A returned unexpected failure code {drifted_a.code}"
            )
        if provider.effect_count() != 2:
            raise AssertionError(
                "drifted A must fail before another provider effect"
            )
        print(
            "CASE D4 drifted A        -> "
            "effects=2 failure=once_operation_conflict"
        )

    print(
        "PASS: A executes once; retry A replays; identical B executes as "
        "new work; drifted A is rejected."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

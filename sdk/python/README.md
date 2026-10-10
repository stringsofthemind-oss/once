# once-agent-sdk

Execution safety for consequential AI agent tool calls.

Once helps applications avoid blindly repeating real-world side effects after ambiguous outcomes such as timeouts, crashes, lost responses, queue redelivery, or agent retries.

Examples include refunds, payments, payouts, bookings, orders, provisioning, deployments, API mutations, and other operations that change external state.

## Install

```bash
pip install once-agent-sdk
```

Published package: https://pypi.org/project/once-agent-sdk/

## Quick start

This hosted-client example needs an `ONCE_API_KEY` and a reviewed provider
registered under `my-provider`; the alias below is a placeholder. Installation
alone does not register a payment provider or protect other tool calls. Set the
key before constructing `Once`. Do not run this against real money for a smoke test.

```python
from once_agent import Once

once = Once()

order_id = "order_123"
refund_intent_id = "refund_request_456"  # Persist once for this intentional refund.
operation_id = Once.id("merchant_7", "refund", refund_intent_id)

result = once.execute(
    operation_id=operation_id,
    provider="my-provider",
    action={
        "type": "refund",
        "order_id": order_id,
        "amount_cents": 5000,
        "currency": "GBP",
        "merchant_id": "merchant_7",
    },
)
```

Set your Once API key in the environment:

```text
ONCE_API_KEY=your_api_key
```

Do not commit API keys to source control.

## Why stable operation identity matters

If an external action succeeds but its response is lost, retrying the action without knowing the prior outcome can duplicate the real-world side effect.

`Once.id(...)` generates a deterministic operation ID, so retries of the same logical operation can retain the same identity.

Use a persisted intent ID and account/tenant authority. Separate intentional
partial refunds on one order need different intent IDs, even if their amounts
match. Bind every effect-bearing field in the reviewed action schema. Do not
mint a new ID to bypass an unresolved original action.

```python
a = Once.id("refund", "order_123")
b = Once.id("refund", "order_123")

assert a == b
```

## Claim boundary

Once does not claim universal exactly-once execution.

Execution safety depends on stable operation identity, durable Once state, the provider integration, and sufficiently authoritative provider truth. When an outcome cannot be established safely, Once can preserve uncertainty instead of blindly repeating the external action.

## Links

- PyPI: https://pypi.org/project/once-agent-sdk/
- Website: https://onceexec.com/
- GitHub: https://github.com/stringsofthemind-oss/once
- Agent guide: https://onceexec.com/agent.md
- MCP package: https://www.npmjs.com/package/@once-agent/mcp

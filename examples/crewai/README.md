# Once + CrewAI

Safe retries for consequential CrewAI tool calls using Once.

A CrewAI agent may call tools that create real-world side effects such as refunds, payments, bookings, orders, provisioning, or deployments.

If the external action succeeds but its response is lost or times out, blindly calling the tool again can repeat that side effect.

This example gives the logical refund a stable Once operation identity before execution.

## Install

```bash
python -m venv .venv
```

Windows:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Configure

Copy `.env.example` to `.env` and provide:

- `OPENAI_API_KEY` for the CrewAI agent
- `ONCE_API_KEY` for Once
- `ONCE_PROVIDER_ALIAS` for your configured Once provider
- `ORDER_ID` for the example operation

Do not commit `.env` or API keys.

## Run

```powershell
.\.venv\Scripts\python.exe main.py
```

## Core pattern

```python
operation_id = Once.id("refund", order_id)

result = once.execute(
    operation_id=operation_id,
    provider=provider,
    action={
        "type": "refund",
        "order_id": order_id,
    },
)
```

The same logical refund receives the same operation ID on retry.

## Structural smoke test

The smoke test does not execute a real refund:

```powershell
.\.venv\Scripts\python.exe smoke_test.py
```

Expected:

```text
CrewAI tool creation: PASS
Stable Once identity: PASS
Distinct Once identity: PASS
```

## Claim boundary

Once does not claim universal exactly-once execution.

Safety depends on stable operation identity, durable Once state, the provider integration, and sufficiently authoritative provider truth. When an outcome cannot be established safely, Once can preserve uncertainty instead of blindly repeating the external action.

## Links

- Once: https://onceexec.com/
- Python SDK: https://pypi.org/project/once-agent-sdk/
- Repository: https://github.com/stringsofthemind-oss/once

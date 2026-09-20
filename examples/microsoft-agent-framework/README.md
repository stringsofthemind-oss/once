# Once + Microsoft Agent Framework

Safe retries for consequential Microsoft Agent Framework tool calls using Once.

Agent tools can trigger refunds, payments, bookings, orders, provisioning and other external writes.

If the provider performs the action but the response is lost or times out, blindly running the tool again can repeat the real-world side effect.

This example gives each logical refund a stable Once operation identity before execution.

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

- `OPENAI_API_KEY`
- `OPENAI_MODEL` if you want to override the default
- `ONCE_API_KEY`
- `ONCE_PROVIDER_ALIAS`
- `ORDER_ID`

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

The smoke test constructs the Agent Framework tool and agent but does not call OpenAI or execute a real refund:

```powershell
.\.venv\Scripts\python.exe smoke_test.py
```

Expected:

```text
Microsoft Agent Framework tool: PASS
Agent construction: PASS
Stable Once identity: PASS
Distinct Once identity: PASS
```

## Claim boundary

Once does not claim universal exactly-once execution.

Safety depends on stable operation identity, durable Once state, the provider integration, and sufficiently authoritative provider truth. When an outcome cannot be established safely, Once can preserve uncertainty instead of blindly repeating the external action.

## Links

- Once: https://onceexec.pages.dev/
- Python SDK: https://pypi.org/project/once-agent-sdk/
- Microsoft Agent Framework docs: https://learn.microsoft.com/agent-framework/
- Repository: https://github.com/stringsofthemind-oss/once

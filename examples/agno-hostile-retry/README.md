# Agno hostile-retry evidence

This lab reproduces the failure shape reported in `agno-agi/agno#10366` and measures the only counter that matters: **committed external effects**.

It intentionally does not patch Agno.

The same `Agent(retries=2)` run is executed twice against a deterministic loopback OpenAI-compatible model:

| path | Agno tool invocations | changing `tool_call_id` | external effects |
|---|---:|---|---:|
| control | 3 | `call_1`, `call_3`, `call_5` | 3 |
| Once | 3 | `call_1`, `call_3`, `call_5` | 1 |

The protected path uses the **published** `@once-agent/sdk@0.1.12` package, not repository source.

## Why the identity is different from `tool_call_id`

The scripted model emits a fresh tool-call ID on every retry, matching the measurement in the Agno issue. The model emits only `amount`; it does **not** emit the Once operation identity.

The logical operation ID (`caller-checkout-0001`) is owned by the caller and captured outside model output. That keeps transport/model attempt identity separate from business intent identity.

## Shape

```text
one caller request
      |
      v
Agno Agent(retries=2)
      |
      +--> attempt 1: tool_call_id=call_1 --> charge_card --> later model 500
      +--> attempt 2: tool_call_id=call_3 --> charge_card --> later model 500
      +--> attempt 3: tool_call_id=call_5 --> charge_card --> later model 500

control boundary: 3 requests --> 3 committed effects
Once boundary:    3 requests --> 1 committed effect
```

Once sits below the framework retry loop. Agno is free to retry; the protected execution boundary decides whether the same logical external effect may execute again.

## Reproduce locally

Requirements:

- Node.js 24.15+
- Python 3.12+

From this directory:

```bash
npm install --no-save --no-package-lock @once-agent/sdk@0.1.12
python -m pip install "agno==3.0.10" "openai==3.16.2"
python verify.py
```

The verifier uses loopback only at runtime: one local scripted model server and one local Node execution sidecar. No live model, payment provider, or external MCP server is contacted.

A successful run writes `evidence.json` and asserts:

1. both paths receive `call_1`, `call_3`, `call_5`;
2. Agno invokes the tool three times in both paths;
3. the control commits three durable ledger entries;
4. the Once path receives the same three requests but commits exactly one durable ledger entry.

## Scope

This is a deliberately narrow reproduction of the retry-after-success case. It demonstrates that the released Once execution boundary can prevent duplicate effects when a trustworthy logical operation identity is available outside regenerated tool-call IDs.

It does **not** claim that Once can infer a stable business identity from arbitrary re-planning model output. Missing or untrustworthy identity remains a fail-closed problem, not permission to guess.

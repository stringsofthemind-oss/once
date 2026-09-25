# Additional framework adapters

This document covers the deferred Phase 11 framework adapters tracked by issue #128.

The adapters are implemented in:

```text
sdk/python/src/once_agent/additional_framework_adapters.py
```

They cover:

- CrewAI
- LlamaIndex
- Agno

## Safety boundary

These adapters observe already-materialized runtime state. They do **not**:

- import or initialise the framework;
- invoke a tool;
- call a model or provider;
- contact MCP;
- resolve a dynamic tool/toolset factory;
- call framework serializers such as `model_json_schema()` or `to_openai_tool()` merely to discover a tool;
- retain tool arguments, results, error content, credentials, or auth material in execution evidence.

Getter-backed and otherwise opaque runtime state stays unresolved instead of being executed or guessed.

## Evidence levels

Registered discovery emits `RUNTIME_REGISTERED` evidence.

Model-visible discovery consumes an already-built/materialized tool definition and emits `MODEL_VISIBLE` evidence.

Terminal execution observation emits `EXECUTED` evidence only when the caller supplies the exact discovered tool observation being correlated. The adapter does not select between same-named tools from name-only telemetry.

Descriptor identity includes a stable fingerprint of the safe descriptor retained during discovery. Same-named tools with different safe descriptions, schemas, or metadata therefore remain distinct.

## CrewAI

Registered discovery:

```python
from once_agent.additional_framework_adapters import discover_crewai_registered_tools

snapshot = discover_crewai_registered_tools(agent, "support-agent")
```

The adapter inspects already-attached `agent.tools` / BaseTool-like state without running `_run` or another tool method.

Model-visible discovery accepts the already-materialized tool definitions that an integration has prepared for the model:

```python
from once_agent.additional_framework_adapters import discover_crewai_model_visible_tools

snapshot = discover_crewai_model_visible_tools(materialized_tools, "support-agent")
```

Execution observation consumes existing CrewAI terminal tool-usage events. `tool_usage_finished` maps to success unless the event reports a failure; CrewAI error/failure terminal events map to failure. Tool args, output and error content are intentionally omitted.

## LlamaIndex

Registered discovery observes already-attached BaseTool-like entries and safe own data from already-materialized `ToolMetadata`. It does not call `ToolMetadata.to_openai_tool()`, `get_parameters_dict()`, or execute the tool.

```python
from once_agent.additional_framework_adapters import discover_llamaindex_registered_tools

snapshot = discover_llamaindex_registered_tools(tools, "travel-agent")
```

Model-visible discovery consumes already-built tool definitions:

```python
from once_agent.additional_framework_adapters import discover_llamaindex_model_visible_tools

snapshot = discover_llamaindex_model_visible_tools(materialized_tools, "travel-agent")
```

Execution observation accepts an existing `ToolCallResult`-like event. `ToolOutput.is_error=False` maps to success, `True` maps to failure, and an unavailable error disposition remains `UNKNOWN`. Raw input/output and exception content are not retained.

## Agno

Registered discovery observes `Agent.tools` and already-materialized Toolkit `functions` without resolving dynamic factories:

```python
from once_agent.additional_framework_adapters import discover_agno_registered_tools

snapshot = discover_agno_registered_tools(agent, "billing-agent")
```

Model-visible discovery consumes already-built Agno function/tool definitions:

```python
from once_agent.additional_framework_adapters import discover_agno_model_visible_tools

snapshot = discover_agno_model_visible_tools(materialized_functions, "billing-agent")
```

Execution observation consumes existing `ToolCallCompleted` / `ToolCallError` event objects. Agno's per-attempt `tool_call_id` is deliberately **not** retained or used as logical operation identity.

That boundary matters because the Agno hostile-retry reproduction in `examples/agno-hostile-retry/` measures changing `tool_call_id` values (`call_1`, `call_3`, `call_5`) across retries of the same caller-owned logical operation.

## Claim boundary

Discovery and execution observation are evidence collection, not permission to execute.

These adapters do not weaken Gateway `DIRECT | PROTECT | BLOCK` routing, do not infer a business idempotency identity from framework transport IDs, and do not turn ambiguous execution evidence into `ABSENT` or permission to retry.

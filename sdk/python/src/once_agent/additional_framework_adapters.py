"""Secret-minimal adapters for deferred Python agent frameworks.

These helpers inspect already-materialized framework state only. They do not
import CrewAI, LlamaIndex, or Agno; call models/providers/MCP; resolve dynamic
tool factories; invoke tools; or retain tool arguments/results/errors.

Execution observation requires the exact discovered tool observation, so
name-only telemetry never chooses between same-named tools.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import re
from dataclasses import asdict, dataclass
from types import FunctionType
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

_SECRET_KEY = re.compile(
    r"(?:^|[_-])(authorization|api[_-]?key|token|password|passwd|secret|credential|cookie)(?:$|[_-])",
    re.IGNORECASE,
)
_READ_ONLY_NAME = re.compile(
    r"(?:^|[_-])(search|lookup|retrieve|fetch|get|list|read|find|query)(?:$|[_-])",
    re.IGNORECASE,
)
_FRAMEWORKS = {"crewai", "llamaindex", "agno"}


@dataclass(frozen=True)
class FrameworkToolObservation:
    tool_id: str
    descriptor_fingerprint: str
    namespaced_name: str
    canonical_name: str
    description: str
    tool_type: str
    framework: str
    source: str
    index: int
    evidence_level: str
    runtime_registered: bool
    model_visible: bool
    executed: bool
    parameters_json_schema: Optional[Any]
    safe_metadata: Dict[str, Any]
    read_only_hint: Optional[bool]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class FrameworkRuntimeSnapshot:
    framework: str
    runtime_name: Optional[str]
    evidence_level: str
    tools: List[FrameworkToolObservation]
    opaque_tool_source_count: int = 0
    external_calls_made: bool = False
    tool_invocations_made: bool = False
    secret_values_retained: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class FrameworkExecutionObservation:
    tool_id: str
    descriptor_fingerprint: str
    namespaced_name: str
    canonical_name: str
    framework: str
    runtime_name: Optional[str]
    source: str
    status: str
    evidence_level: str = "EXECUTED"
    arguments_retained: bool = False
    result_retained: bool = False
    error_content_retained: bool = False
    transport_call_id_retained: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _instance_dict(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    try:
        raw = object.__getattribute__(value, "__dict__")
    except (AttributeError, TypeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _class_dict(value: Any) -> Mapping[str, Any]:
    try:
        raw = type(value).__dict__
    except (AttributeError, TypeError):
        return {}
    return raw if isinstance(raw, Mapping) else {}


def _has_callable_marker(value: Any, keys: Iterable[str]) -> bool:
    """Detect a resolver/factory without binding or invoking descriptors."""
    data = _instance_dict(value)
    class_data = _class_dict(value)
    for key in keys:
        if callable(data.get(key)):
            return True
        descriptor = class_data.get(key)
        if callable(descriptor):
            return True
    return False


def _safe_json(value: Any, depth: int = 0, secret_context: bool = False) -> Any:
    if depth > 12:
        return None
    if value is None or isinstance(value, (str, bool, int, float)):
        return "<redacted>" if secret_context and value is not None else value
    if isinstance(value, (list, tuple)):
        return [_safe_json(item, depth + 1, secret_context) for item in value]
    if isinstance(value, Mapping):
        output: Dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                continue
            output[key] = _safe_json(
                item,
                depth + 1,
                secret_context or bool(_SECRET_KEY.search(key)),
            )
        return output

    # Non-plain runtime/schema objects remain opaque. Calling serializers such
    # as model_json_schema()/to_openai_tool() would execute framework code.
    return None


def _stable_hash(value: Any) -> str:
    payload = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _function_identity(value: Any) -> Tuple[Optional[str], str]:
    if not isinstance(value, FunctionType) and not inspect.isfunction(value):
        return None, ""
    try:
        name = object.__getattribute__(value, "__name__")
    except (AttributeError, TypeError):
        name = None
    try:
        description = object.__getattribute__(value, "__doc__") or ""
    except (AttributeError, TypeError):
        description = ""
    if not isinstance(name, str) or not name.strip():
        return None, ""
    return name, description if isinstance(description, str) else ""


def _namespace(framework: str, runtime_name: Optional[str]) -> str:
    return f"{framework}/{runtime_name or 'runtime'}"


def _safe_metadata(data: Mapping[str, Any]) -> Dict[str, Any]:
    output: Dict[str, Any] = {}
    for field in (
        "return_direct",
        "result_as_answer",
        "strict",
        "requires_confirmation",
        "requires_user_input",
        "external_execution",
        "external_execution_required",
        "stop_after_tool_call",
        "cache_results",
    ):
        value = data.get(field)
        if isinstance(value, (str, bool, int, float)):
            output[field] = value
    return output


def _openai_function_data(value: Any) -> Optional[Mapping[str, Any]]:
    data = _instance_dict(value)
    if data.get("type") != "function":
        return None
    function = data.get("function")
    return function if isinstance(function, Mapping) else None


def _metadata_data(value: Any) -> Mapping[str, Any]:
    data = _instance_dict(value)
    for key in ("metadata", "_metadata"):
        metadata = data.get(key)
        metadata_data = _instance_dict(metadata)
        if metadata_data:
            return metadata_data
    return {}


def _raw_tool_parts(
    value: Any,
) -> Tuple[Optional[str], str, Optional[Any], str, Dict[str, Any]]:
    function_name, function_description = _function_identity(value)
    data = _instance_dict(value)

    nested = _openai_function_data(value)
    if nested is not None:
        name = nested.get("name")
        description = nested.get("description") or ""
        schema = nested.get("parameters")
        return (
            name if isinstance(name, str) and name.strip() else None,
            description if isinstance(description, str) else "",
            _safe_json(schema) if schema is not None else None,
            "function",
            _safe_metadata(nested),
        )

    metadata = _metadata_data(value)

    name = function_name
    if name is None:
        for candidate in (
            data.get("name"),
            data.get("tool_name"),
            data.get("function_name"),
            metadata.get("name"),
        ):
            if isinstance(candidate, str) and candidate.strip():
                name = candidate
                break

    description: Any = function_description
    if not description:
        for candidate in (
            data.get("description"),
            data.get("description_for_model"),
            metadata.get("description"),
        ):
            if isinstance(candidate, str):
                description = candidate
                break

    schema = None
    for candidate in (
        data.get("parameters_json_schema"),
        data.get("parameters"),
        data.get("input_schema"),
        data.get("args_schema"),
        metadata.get("parameters"),
        metadata.get("input_schema"),
    ):
        if candidate is not None:
            schema = _safe_json(candidate)
            break

    tool_type = data.get("tool_type")
    if not isinstance(tool_type, str) or not tool_type.strip():
        if function_name:
            tool_type = "python_function"
        elif metadata:
            tool_type = "framework_tool"
        else:
            tool_type = (
                type(value).__name__
                if not isinstance(value, Mapping)
                else "tool"
            )

    combined = dict(_safe_metadata(data))
    combined.update(_safe_metadata(metadata))

    return (
        name,
        description if isinstance(description, str) else "",
        schema,
        tool_type,
        combined,
    )


def _mapping_items(raw: Mapping[Any, Any]) -> List[Any]:
    items: List[Any] = []
    for map_name, item in raw.items():
        if isinstance(item, Mapping) and not any(
            isinstance(item.get(candidate), str) and item.get(candidate).strip()
            for candidate in ("name", "tool_name", "function_name")
        ):
            copied = dict(item)
            if isinstance(map_name, str):
                copied["name"] = map_name
            items.append(copied)
        else:
            items.append(item)
    return items


def _iter_container(value: Any, keys: Tuple[str, ...]) -> Tuple[List[Any], int]:
    if isinstance(value, (list, tuple)):
        return list(value), 0

    data = _instance_dict(value)
    for key in keys:
        raw = data.get(key)
        if isinstance(raw, (list, tuple)):
            return list(raw), 0
        if isinstance(raw, Mapping):
            return _mapping_items(raw), 0

    # A callable factory/tool resolver is an opaque source; never bind/call it.
    if _has_callable_marker(value, keys):
        return [], 1
    return [], 0


def _agno_expand_registered(items: Iterable[Any]) -> Tuple[List[Any], int]:
    expanded: List[Any] = []
    opaque = 0
    resolver_keys = ("get_tools", "get_functions", "list_tools")

    for item in items:
        function_name, _ = _function_identity(item)
        if function_name:
            expanded.append(item)
            continue

        data = _instance_dict(item)
        functions = data.get("functions")
        if isinstance(functions, Mapping):
            expanded.extend(_mapping_items(functions))
            continue

        # A toolkit/factory whose concrete functions are not already
        # materialized stays opaque. Check both own fields and class-defined
        # methods without binding/invoking descriptors.
        if _has_callable_marker(item, resolver_keys):
            opaque += 1
            continue

        expanded.append(item)

    return expanded, opaque


def _observe_tools(
    framework: str,
    raw_items: Iterable[Any],
    *,
    runtime_name: Optional[str],
    evidence_level: str,
    source: str,
) -> List[FrameworkToolObservation]:
    tools: List[FrameworkToolObservation] = []
    ns = _namespace(framework, runtime_name)
    model_visible = evidence_level == "MODEL_VISIBLE"

    for index, raw_tool in enumerate(raw_items):
        name, description, schema, tool_type, metadata = _raw_tool_parts(raw_tool)
        if not isinstance(name, str) or not name.strip():
            continue

        safe_descriptor = {
            "framework": framework,
            "namespace": ns,
            "name": name,
            "description": description,
            "tool_type": tool_type,
            "schema": schema,
            "metadata": metadata,
        }
        fingerprint = _stable_hash(safe_descriptor)
        tools.append(
            FrameworkToolObservation(
                tool_id=f"tool:{fingerprint}",
                descriptor_fingerprint=fingerprint,
                namespaced_name=f"{ns}/{name}",
                canonical_name=name,
                description=description,
                tool_type=tool_type,
                framework=framework,
                source=source,
                index=index,
                evidence_level=evidence_level,
                runtime_registered=True,
                model_visible=model_visible,
                executed=False,
                parameters_json_schema=schema,
                safe_metadata=metadata,
                read_only_hint=(
                    True if _READ_ONLY_NAME.search(name) else None
                ),
            )
        )

    return tools


def _discover_registered(
    framework: str,
    value: Any,
    *,
    runtime_name: Optional[str],
    keys: Tuple[str, ...],
    source: str,
) -> FrameworkRuntimeSnapshot:
    items, opaque = _iter_container(value, keys)
    if framework == "agno":
        items, nested_opaque = _agno_expand_registered(items)
        opaque += nested_opaque

    return FrameworkRuntimeSnapshot(
        framework=framework,
        runtime_name=runtime_name,
        evidence_level="RUNTIME_REGISTERED",
        tools=_observe_tools(
            framework,
            items,
            runtime_name=runtime_name,
            evidence_level="RUNTIME_REGISTERED",
            source=source,
        ),
        opaque_tool_source_count=opaque,
    )


def _discover_visible(
    framework: str,
    value: Any,
    *,
    runtime_name: Optional[str],
    keys: Tuple[str, ...],
    source: str,
) -> FrameworkRuntimeSnapshot:
    items, opaque = _iter_container(value, keys)
    return FrameworkRuntimeSnapshot(
        framework=framework,
        runtime_name=runtime_name,
        evidence_level="MODEL_VISIBLE",
        tools=_observe_tools(
            framework,
            items,
            runtime_name=runtime_name,
            evidence_level="MODEL_VISIBLE",
            source=source,
        ),
        opaque_tool_source_count=opaque,
    )


def discover_crewai_registered_tools(
    agent_or_tools: Any,
    runtime_name: Optional[str] = None,
) -> FrameworkRuntimeSnapshot:
    """Observe attached CrewAI BaseTool-like entries without running them."""
    return _discover_registered(
        "crewai",
        agent_or_tools,
        runtime_name=runtime_name,
        keys=("tools",),
        source="crewai.agent.tools",
    )


def discover_crewai_model_visible_tools(
    materialized_tools: Any,
    runtime_name: Optional[str] = None,
) -> FrameworkRuntimeSnapshot:
    """Observe already-materialized CrewAI model tool definitions."""
    return _discover_visible(
        "crewai",
        materialized_tools,
        runtime_name=runtime_name,
        keys=("tools", "available_tools", "functions"),
        source="crewai.model_visible_tools",
    )


def discover_llamaindex_registered_tools(
    agent_or_tools: Any,
    runtime_name: Optional[str] = None,
) -> FrameworkRuntimeSnapshot:
    """Observe attached LlamaIndex BaseTool-like entries without serializers."""
    return _discover_registered(
        "llamaindex",
        agent_or_tools,
        runtime_name=runtime_name,
        keys=("tools", "_tools"),
        source="llamaindex.agent.tools",
    )


def discover_llamaindex_model_visible_tools(
    materialized_tools: Any,
    runtime_name: Optional[str] = None,
) -> FrameworkRuntimeSnapshot:
    """Observe already-built LlamaIndex model tool definitions."""
    return _discover_visible(
        "llamaindex",
        materialized_tools,
        runtime_name=runtime_name,
        keys=("tools", "tool_specs", "functions"),
        source="llamaindex.model_visible_tools",
    )


def discover_agno_registered_tools(
    agent_or_tools: Any,
    runtime_name: Optional[str] = None,
) -> FrameworkRuntimeSnapshot:
    """Observe Agno Agent.tools/materialized Toolkit functions only."""
    return _discover_registered(
        "agno",
        agent_or_tools,
        runtime_name=runtime_name,
        keys=("tools",),
        source="agno.agent.tools",
    )


def discover_agno_model_visible_tools(
    materialized_tools: Any,
    runtime_name: Optional[str] = None,
) -> FrameworkRuntimeSnapshot:
    """Observe already-built Agno model-visible function/tool definitions."""
    return _discover_visible(
        "agno",
        materialized_tools,
        runtime_name=runtime_name,
        keys=("tools", "functions", "tool_definitions"),
        source="agno.model_visible_tools",
    )


def _event_tool_name(event: Any, *, nested_tool: bool = False) -> Optional[str]:
    data = _instance_dict(event)
    if nested_tool:
        tool_data = _instance_dict(data.get("tool"))
        name = tool_data.get("tool_name") or tool_data.get("name")
    else:
        name = data.get("tool_name") or data.get("name")
    return name if isinstance(name, str) and name.strip() else None


def _execution(
    *,
    framework: str,
    event: Any,
    tool: FrameworkToolObservation,
    status: Optional[str],
    source: str,
    nested_tool: bool = False,
) -> Optional[FrameworkExecutionObservation]:
    if framework not in _FRAMEWORKS or tool.framework != framework:
        return None
    if status not in {"SUCCEEDED", "FAILED", "UNKNOWN"}:
        return None

    event_name = _event_tool_name(event, nested_tool=nested_tool)
    if event_name is not None and event_name != tool.canonical_name:
        return None

    parts = tool.namespaced_name.split("/", 2)
    runtime_name = (
        parts[1]
        if len(parts) >= 3 and parts[1] != "runtime"
        else None
    )

    return FrameworkExecutionObservation(
        tool_id=tool.tool_id,
        descriptor_fingerprint=tool.descriptor_fingerprint,
        namespaced_name=tool.namespaced_name,
        canonical_name=tool.canonical_name,
        framework=framework,
        runtime_name=runtime_name,
        source=source,
        status=status,
    )


def observe_crewai_execution(
    event: Any,
    tool: FrameworkToolObservation,
) -> Optional[FrameworkExecutionObservation]:
    """Consume an existing CrewAI terminal tool-usage event."""
    data = _instance_dict(event)
    event_type = data.get("type") or data.get("event")

    if event_type == "tool_usage_finished":
        status = "FAILED" if data.get("failure") is not None else "SUCCEEDED"
    elif event_type in {
        "tool_usage_error",
        "tool_failure_detected",
        "tool_execution_error",
    }:
        status = "FAILED"
    else:
        return None

    return _execution(
        framework="crewai",
        event=event,
        tool=tool,
        status=status,
        source="crewai.tool_usage_event",
    )


def observe_llamaindex_execution(
    event: Any,
    tool: FrameworkToolObservation,
) -> Optional[FrameworkExecutionObservation]:
    """Consume an existing LlamaIndex ToolCallResult-like event."""
    data = _instance_dict(event)
    output = data.get("tool_output")
    if output is None:
        return None

    output_data = _instance_dict(output)
    is_error = output_data.get("is_error")
    status = (
        "FAILED"
        if is_error is True
        else "SUCCEEDED"
        if is_error is False
        else "UNKNOWN"
    )

    return _execution(
        framework="llamaindex",
        event=event,
        tool=tool,
        status=status,
        source="llamaindex.tool_call_result",
    )


def observe_agno_execution(
    event: Any,
    tool: FrameworkToolObservation,
) -> Optional[FrameworkExecutionObservation]:
    """Consume an existing Agno ToolCallCompleted/ToolCallError event.

    Agno's transport/model tool_call_id is deliberately ignored and never
    copied into the observation.
    """
    data = _instance_dict(event)
    event_type = data.get("event") or data.get("type")
    nested = _instance_dict(data.get("tool"))

    if event_type == "ToolCallError":
        status = "FAILED"
    elif event_type == "ToolCallCompleted":
        status = (
            "FAILED"
            if nested.get("tool_call_error") is True
            else "SUCCEEDED"
        )
    else:
        return None

    return _execution(
        framework="agno",
        event=event,
        tool=tool,
        status=status,
        source="agno.tool_call_event",
        nested_tool=True,
    )

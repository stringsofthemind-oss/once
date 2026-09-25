"""Read-only Strands Agents tool discovery for Once.

The adapter consumes already-materialized ToolSpec/ToolConfig data. It never
asks a Strands ToolRegistry to process/load tools, never imports a tool module,
and never invokes an AgentTool, MCP tool, model, or provider.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional

_SECRET_KEY = re.compile(
    r"(?:^|[_-])(authorization|api[_-]?key|token|password|passwd|secret|credential|cookie)(?:$|[_-])",
    re.IGNORECASE,
)

_READ_ONLY_NAME = re.compile(
    r"(?:^|[_-])(search|lookup|retrieve|fetch|get|list|read|find|describe|inspect)(?:$|[_-])",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class StrandsToolObservation:
    tool_id: str
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
    input_schema: Optional[Any]
    output_schema: Optional[Any]
    safe_annotations: Dict[str, Any]
    read_only_hint: Optional[bool]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class StrandsRuntimeSnapshot:
    framework: str
    runtime_name: Optional[str]
    evidence_level: str
    tools: List[StrandsToolObservation]
    external_calls_made: bool = False
    tool_invocations_made: bool = False
    secret_values_retained: bool = False

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


def _safe_json(value: Any, depth: int = 0, secret_context: bool = False) -> Any:
    if depth > 12:
        return None
    if value is None or isinstance(value, (str, bool, int, float)):
        return "<redacted>" if secret_context and value is not None else value
    if isinstance(value, (list, tuple)):
        return [_safe_json(item, depth + 1, secret_context) for item in value]
    if isinstance(value, dict):
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
    return None


def _stable_id(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "tool:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _namespace(runtime_name: Optional[str]) -> str:
    return f"strands/{runtime_name or 'runtime'}"


def _materialized_tools(value: Any) -> Iterable[Any]:
    if isinstance(value, (list, tuple)):
        return value

    data = _instance_dict(value)
    tools = data.get("tools")
    if isinstance(tools, (list, tuple)):
        return tools

    # Some callers may pass a single already-materialized ToolSpec directly.
    if isinstance(data.get("name"), str):
        return [value]

    return []


def _unwrap_tool_spec(value: Any) -> Mapping[str, Any]:
    data = _instance_dict(value)
    wrapped = data.get("toolSpec")
    if wrapped is not None:
        return _instance_dict(wrapped)
    wrapped = data.get("tool_spec")
    if wrapped is not None:
        return _instance_dict(wrapped)
    return data


def _annotations(spec: Mapping[str, Any]) -> Dict[str, Any]:
    raw = spec.get("annotations")
    if not isinstance(raw, dict):
        return {}

    allowed = (
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
        "title",
    )
    output: Dict[str, Any] = {}
    for key in allowed:
        value = raw.get(key)
        if isinstance(value, (str, bool, int, float)):
            output[key] = value
    return output


def _observe(
    raw_tool: Any,
    *,
    evidence_level: str,
    source: str,
    runtime_name: Optional[str],
    index: int,
) -> Optional[StrandsToolObservation]:
    spec = _unwrap_tool_spec(raw_tool)
    name = spec.get("name")
    if not isinstance(name, str) or not name.strip():
        return None

    description = spec.get("description")
    if not isinstance(description, str):
        description = ""

    input_schema = _safe_json(spec.get("inputSchema"))
    output_schema = _safe_json(spec.get("outputSchema"))
    annotations = _annotations(spec)

    read_only_hint: Optional[bool]
    if isinstance(annotations.get("readOnlyHint"), bool):
        read_only_hint = bool(annotations["readOnlyHint"])
    else:
        read_only_hint = True if _READ_ONLY_NAME.search(name) else None

    ns = _namespace(runtime_name)
    identity = {
        "framework": "strands",
        "namespace": ns,
        "name": name,
        "description": description,
        "input_schema": input_schema,
        "output_schema": output_schema,
    }

    return StrandsToolObservation(
        tool_id=_stable_id(identity),
        namespaced_name=f"{ns}/{name}",
        canonical_name=name,
        description=description,
        tool_type="tool_spec",
        framework="strands",
        source=source,
        index=index,
        evidence_level=evidence_level,
        runtime_registered=True,
        model_visible=evidence_level == "MODEL_VISIBLE",
        executed=False,
        input_schema=input_schema,
        output_schema=output_schema,
        safe_annotations=annotations,
        read_only_hint=read_only_hint,
    )


def _discover(
    value: Any,
    *,
    evidence_level: str,
    source: str,
    runtime_name: Optional[str],
) -> List[StrandsToolObservation]:
    observations: List[StrandsToolObservation] = []
    for index, raw_tool in enumerate(_materialized_tools(value)):
        observed = _observe(
            raw_tool,
            evidence_level=evidence_level,
            source=source,
            runtime_name=runtime_name,
            index=index,
        )
        if observed is not None:
            observations.append(observed)
    return observations


def discover_strands_registered_tools(
    materialized_registry_config_or_specs: Any,
    runtime_name: Optional[str] = None,
) -> StrandsRuntimeSnapshot:
    """Observe already-materialized registered Strands ToolSpec data.

    Pass a list of ToolSpec objects or the already-returned JSON-like result of a
    registry inspection. This helper intentionally does not call
    ToolRegistry.process_tools(), get_all_tools_config(), or get_all_tool_specs().
    """
    tools = _discover(
        materialized_registry_config_or_specs,
        evidence_level="RUNTIME_REGISTERED",
        source="strands.tool_registry.materialized_config",
        runtime_name=runtime_name,
    )
    return StrandsRuntimeSnapshot(
        framework="strands",
        runtime_name=runtime_name,
        evidence_level="RUNTIME_REGISTERED",
        tools=tools,
    )


def discover_strands_model_visible_tools(
    tool_config_or_tools: Any,
    runtime_name: Optional[str] = None,
) -> StrandsRuntimeSnapshot:
    """Observe an already-built Strands ToolConfig.tools model payload."""
    tools = _discover(
        tool_config_or_tools,
        evidence_level="MODEL_VISIBLE",
        source="strands.model.tool_config.tools",
        runtime_name=runtime_name,
    )
    return StrandsRuntimeSnapshot(
        framework="strands",
        runtime_name=runtime_name,
        evidence_level="MODEL_VISIBLE",
        tools=tools,
    )

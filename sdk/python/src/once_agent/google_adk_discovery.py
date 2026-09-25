"""Read-only Google ADK / Gemini tool discovery for Once.

The helpers in this module inspect already-existing runtime data only. They do
not import Google ADK or google-genai, resolve toolsets, call MCP, invoke tools,
process an LLM request, or contact a model/provider.
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
    r"(?:^|[_-])(search|lookup|retrieve|fetch|get|list|read|find|maps?)(?:$|[_-])",
    re.IGNORECASE,
)

_BUILTIN_READ_TOOLS: Tuple[Tuple[str, str], ...] = (
    ("google_search", "google_search"),
    ("google_maps", "google_maps"),
    ("url_context", "url_context"),
)


@dataclass(frozen=True)
class GoogleADKToolObservation:
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
    parameters_json_schema: Optional[Any]
    safe_metadata: Dict[str, Any]
    read_only_hint: Optional[bool]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class GoogleADKRuntimeSnapshot:
    framework: str
    runtime_name: Optional[str]
    evidence_level: str
    tools: List[GoogleADKToolObservation]
    opaque_tool_source_count: int = 0
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
    return f"google-adk/{runtime_name or 'runtime'}"


def _is_opaque_tool_source(value: Any) -> bool:
    data = _instance_dict(value)
    try:
        class_dict = type(value).__dict__
    except (AttributeError, TypeError):
        class_dict = {}

    # These identify a source that must be resolved before concrete tools are
    # known. BaseTool itself may expose process_llm_request, so that method is
    # intentionally NOT a toolset marker.
    callable_markers = (
        "get_tools",
        "list_tools",
        "canonical_tools",
    )

    for key in callable_markers:
        if callable(data.get(key)):
            return True
        descriptor = class_dict.get(key) if isinstance(class_dict, Mapping) else None
        if callable(descriptor):
            return True

    return False


def _registered_items(value: Any) -> Tuple[Iterable[Any], int]:
    if isinstance(value, (list, tuple)):
        raw = list(value)
    else:
        data = _instance_dict(value)
        tools = data.get("tools")
        raw = list(tools) if isinstance(tools, (list, tuple)) else []

    visible: List[Any] = []
    opaque = 0
    for item in raw:
        if _is_opaque_tool_source(item):
            opaque += 1
            continue
        visible.append(item)
    return visible, opaque


def _observe_registered_tool(
    raw_tool: Any,
    *,
    runtime_name: Optional[str],
    index: int,
) -> Optional[GoogleADKToolObservation]:
    function_name, function_description = _function_identity(raw_tool)
    data = _instance_dict(raw_tool)

    name = function_name or data.get("name")
    if not isinstance(name, str) or not name.strip():
        return None

    description = function_description or data.get("description") or ""
    if not isinstance(description, str):
        description = ""

    schema = data.get("parameters_json_schema")
    if schema is None:
        schema = data.get("parameters")
    sanitized_schema = _safe_json(schema) if schema is not None else None

    tool_type = "python_function" if function_name else "adk_tool"
    ns = _namespace(runtime_name)
    read_only_hint = True if _READ_ONLY_NAME.search(name) else None

    identity = {
        "framework": "google-adk",
        "namespace": ns,
        "name": name,
        "type": tool_type,
        "description": description,
        "schema": sanitized_schema,
    }

    safe_metadata: Dict[str, Any] = {}
    for field in ("is_long_running", "long_running", "strict"):
        value = data.get(field)
        if isinstance(value, (bool, int, float, str)):
            safe_metadata[field] = value

    return GoogleADKToolObservation(
        tool_id=_stable_id(identity),
        namespaced_name=f"{ns}/{name}",
        canonical_name=name,
        description=description,
        tool_type=tool_type,
        framework="google-adk",
        source="google_adk.agent.tools",
        index=index,
        evidence_level="RUNTIME_REGISTERED",
        runtime_registered=True,
        model_visible=False,
        executed=False,
        parameters_json_schema=sanitized_schema,
        safe_metadata=safe_metadata,
        read_only_hint=read_only_hint,
    )


def _config_tools(value: Any) -> Iterable[Any]:
    if isinstance(value, (list, tuple)):
        return value

    data = _instance_dict(value)
    config = data.get("config")
    if config is not None:
        config_data = _instance_dict(config)
        tools = config_data.get("tools")
        if isinstance(tools, (list, tuple)):
            return tools

    tools = data.get("tools")
    if isinstance(tools, (list, tuple)):
        return tools

    return []


def _function_declarations(tool: Any) -> Iterable[Any]:
    data = _instance_dict(tool)
    declarations = data.get("function_declarations")
    if isinstance(declarations, (list, tuple)):
        return declarations
    return []


def _observe_declaration(
    declaration: Any,
    *,
    runtime_name: Optional[str],
    index: int,
) -> Optional[GoogleADKToolObservation]:
    data = _instance_dict(declaration)
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        return None

    description = data.get("description") or ""
    if not isinstance(description, str):
        description = ""

    schema = data.get("parameters_json_schema")
    if schema is None:
        schema = data.get("parameters")
    sanitized_schema = _safe_json(schema) if schema is not None else None

    ns = _namespace(runtime_name)
    identity = {
        "framework": "google-adk",
        "namespace": ns,
        "name": name,
        "type": "function",
        "description": description,
        "schema": sanitized_schema,
    }

    safe_metadata: Dict[str, Any] = {}
    behavior = data.get("behavior")
    if isinstance(behavior, (str, bool, int, float)):
        safe_metadata["behavior"] = behavior

    return GoogleADKToolObservation(
        tool_id=_stable_id(identity),
        namespaced_name=f"{ns}/{name}",
        canonical_name=name,
        description=description,
        tool_type="function",
        framework="google-adk",
        source="google_adk.llm_request.config.tools",
        index=index,
        evidence_level="MODEL_VISIBLE",
        runtime_registered=True,
        model_visible=True,
        executed=False,
        parameters_json_schema=sanitized_schema,
        safe_metadata=safe_metadata,
        read_only_hint=True if _READ_ONLY_NAME.search(name) else None,
    )


def _observe_builtin(
    tool: Any,
    *,
    runtime_name: Optional[str],
    index: int,
) -> List[GoogleADKToolObservation]:
    data = _instance_dict(tool)
    ns = _namespace(runtime_name)
    observations: List[GoogleADKToolObservation] = []

    for field, name in _BUILTIN_READ_TOOLS:
        marker = data.get(field)
        if marker is None:
            continue
        identity = {
            "framework": "google-adk",
            "namespace": ns,
            "name": name,
            "type": "gemini_builtin",
        }
        observations.append(
            GoogleADKToolObservation(
                tool_id=_stable_id(identity),
                namespaced_name=f"{ns}/{name}",
                canonical_name=name,
                description=f"Gemini built-in {name} tool",
                tool_type="gemini_builtin",
                framework="google-adk",
                source="google_adk.llm_request.config.tools",
                index=index,
                evidence_level="MODEL_VISIBLE",
                runtime_registered=True,
                model_visible=True,
                executed=False,
                parameters_json_schema=None,
                safe_metadata={"builtin": True},
                read_only_hint=True,
            )
        )

    return observations


def discover_google_adk_registered_tools(
    agent_or_tools: Any,
    runtime_name: Optional[str] = None,
) -> GoogleADKRuntimeSnapshot:
    """Observe Agent.tools/static tools without resolving dynamic toolsets."""
    raw_items, opaque_count = _registered_items(agent_or_tools)
    tools: List[GoogleADKToolObservation] = []

    for index, raw_tool in enumerate(raw_items):
        observed = _observe_registered_tool(
            raw_tool,
            runtime_name=runtime_name,
            index=index,
        )
        if observed is not None:
            tools.append(observed)

    return GoogleADKRuntimeSnapshot(
        framework="google-adk",
        runtime_name=runtime_name,
        evidence_level="RUNTIME_REGISTERED",
        tools=tools,
        opaque_tool_source_count=opaque_count,
    )


def discover_google_adk_model_visible_tools(
    llm_request_or_config: Any,
    runtime_name: Optional[str] = None,
) -> GoogleADKRuntimeSnapshot:
    """Observe already-built Gemini/ADK config.tools without processing tools."""
    tools: List[GoogleADKToolObservation] = []
    declaration_index = 0

    for tool_index, raw_tool in enumerate(_config_tools(llm_request_or_config)):
        for declaration in _function_declarations(raw_tool):
            observed = _observe_declaration(
                declaration,
                runtime_name=runtime_name,
                index=declaration_index,
            )
            declaration_index += 1
            if observed is not None:
                tools.append(observed)

        tools.extend(
            _observe_builtin(
                raw_tool,
                runtime_name=runtime_name,
                index=tool_index,
            )
        )

    return GoogleADKRuntimeSnapshot(
        framework="google-adk",
        runtime_name=runtime_name,
        evidence_level="MODEL_VISIBLE",
        tools=tools,
    )

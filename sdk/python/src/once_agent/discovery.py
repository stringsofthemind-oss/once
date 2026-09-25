"""Read-only framework discovery helpers for Once.

This module deliberately uses structural inspection only. It does not import
Pydantic AI, call toolset hooks, prepare tools, execute user functions, or make
model/provider requests.
"""

from __future__ import annotations

import copy
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
    r"(?:^|[_-])(search|lookup|retrieve|fetch|get|list|read|find)(?:$|[_-])",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class PydanticAIRuntimeToolObservation:
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
class PydanticAIRuntimeSnapshot:
    framework: str
    runtime_name: Optional[str]
    evidence_level: str
    tools: List[PydanticAIRuntimeToolObservation]
    external_calls_made: bool = False
    tool_invocations_made: bool = False
    secret_values_retained: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _instance_dict(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    raw = getattr(value, "__dict__", None)
    return raw if isinstance(raw, dict) else {}


def _data_value(value: Any, key: str) -> Any:
    """Return an already-stored field without invoking descriptors/properties."""
    return _instance_dict(value).get(key)


def _safe_json(value: Any, depth: int = 0, secret_context: bool = False) -> Any:
    if depth > 12:
        return None
    if value is None or isinstance(value, (str, bool, int, float)):
        return "<redacted>" if secret_context and value is not None else value
    if isinstance(value, list):
        return [_safe_json(item, depth + 1, secret_context) for item in value]
    if isinstance(value, tuple):
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


def _tool_items(value: Any) -> Iterable[Any]:
    if isinstance(value, (list, tuple)):
        return value

    data = _instance_dict(value)
    tools = data.get("tools")
    if isinstance(tools, dict):
        return list(tools.values())
    if isinstance(tools, (list, tuple)):
        return tools

    return []


def _tool_definition_items(value: Any) -> Iterable[Any]:
    if isinstance(value, (list, tuple)):
        return value

    data = _instance_dict(value)
    tools = data.get("function_tools")
    if isinstance(tools, (list, tuple)):
        return tools

    # Permit an already-built request wrapper without evaluating properties.
    params = data.get("model_request_parameters") or data.get("request_parameters")
    if params is not None:
        nested = _instance_dict(params).get("function_tools")
        if isinstance(nested, (list, tuple)):
            return nested

    return []


def _observe(
    raw_tool: Any,
    *,
    source: str,
    evidence_level: str,
    runtime_name: Optional[str],
    index: int,
) -> Optional[PydanticAIRuntimeToolObservation]:
    data = _instance_dict(raw_tool)
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        return None

    description = data.get("description")
    if not isinstance(description, str):
        description = ""

    schema = data.get("parameters_json_schema")
    if schema is None:
        schema = data.get("json_schema")
    sanitized_schema = _safe_json(schema) if schema is not None else None

    kind = data.get("kind")
    if not isinstance(kind, str):
        kind = "function"

    safe_metadata: Dict[str, Any] = {}
    for field in (
        "strict",
        "sequential",
        "defer_loading",
        "include_return_schema",
        "toolset_id",
        "kind",
    ):
        item = data.get(field)
        if isinstance(item, (str, bool, int, float)) and not _SECRET_KEY.search(field):
            safe_metadata[field] = copy.deepcopy(item)

    metadata = data.get("metadata")
    if isinstance(metadata, dict):
        sanitized_metadata = _safe_json(metadata)
        if sanitized_metadata:
            safe_metadata["metadata"] = sanitized_metadata

    namespace = f"pydantic-ai/{runtime_name or 'runtime'}"
    identity = {
        "framework": "pydantic-ai",
        "namespace": namespace,
        "name": name,
        "kind": kind,
        "description": description,
        "schema": sanitized_schema,
    }

    read_only_hint = True if _READ_ONLY_NAME.search(name) else None

    return PydanticAIRuntimeToolObservation(
        tool_id=_stable_id(identity),
        namespaced_name=f"{namespace}/{name}",
        canonical_name=name,
        description=description,
        tool_type=kind,
        framework="pydantic-ai",
        source=source,
        index=index,
        evidence_level=evidence_level,
        runtime_registered=True,
        model_visible=evidence_level == "MODEL_VISIBLE",
        executed=False,
        parameters_json_schema=sanitized_schema,
        safe_metadata=safe_metadata,
        read_only_hint=read_only_hint,
    )


def discover_pydantic_ai_registered_tools(
    tools_or_toolset: Any,
    runtime_name: Optional[str] = None,
) -> PydanticAIRuntimeSnapshot:
    """Observe statically available Pydantic AI tools without calling a toolset."""
    observations: List[PydanticAIRuntimeToolObservation] = []
    for index, raw_tool in enumerate(_tool_items(tools_or_toolset)):
        observed = _observe(
            raw_tool,
            source="pydantic_ai.tools",
            evidence_level="RUNTIME_REGISTERED",
            runtime_name=runtime_name,
            index=index,
        )
        if observed is not None:
            observations.append(observed)

    return PydanticAIRuntimeSnapshot(
        framework="pydantic-ai",
        runtime_name=runtime_name,
        evidence_level="RUNTIME_REGISTERED",
        tools=observations,
    )


def discover_pydantic_ai_model_visible_tools(
    model_request_parameters: Any,
    runtime_name: Optional[str] = None,
) -> PydanticAIRuntimeSnapshot:
    """Observe already-built ModelRequestParameters.function_tools.

    This is intentionally post-preparation evidence: it accepts only an object
    that already contains the final function_tools list and never asks an agent
    or toolset to build it.
    """
    observations: List[PydanticAIRuntimeToolObservation] = []
    for index, raw_tool in enumerate(_tool_definition_items(model_request_parameters)):
        observed = _observe(
            raw_tool,
            source="pydantic_ai.model_request_parameters.function_tools",
            evidence_level="MODEL_VISIBLE",
            runtime_name=runtime_name,
            index=index,
        )
        if observed is not None:
            observations.append(observed)

    return PydanticAIRuntimeSnapshot(
        framework="pydantic-ai",
        runtime_name=runtime_name,
        evidence_level="MODEL_VISIBLE",
        tools=observations,
    )

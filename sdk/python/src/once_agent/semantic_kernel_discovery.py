"""Read-only Microsoft Semantic Kernel runtime tool discovery for Once.

This module is dependency-free and structural. It inspects already-registered
Kernel plugins/functions or already-materialized model-visible function metadata.
It never loads plugins, evaluates function-choice filters, invokes a KernelFunction,
contacts a model/provider, or executes user code.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

_SECRET_KEY = re.compile(
    r"(?:^|[_-])(authorization|api[_-]?key|token|password|passwd|secret|credential|cookie)(?:$|[_-])",
    re.IGNORECASE,
)
_READ_ONLY_NAME = re.compile(
    r"(?:^|[_-])(search|lookup|retrieve|fetch|get|list|read|find|inspect|view)(?:$|[_-])",
    re.IGNORECASE,
)
_SECRET_PARAMETER_VALUE_KEYS = {
    "default",
    "default_value",
    "example",
    "examples",
    "const",
    "value",
}


@dataclass(frozen=True)
class SemanticKernelToolObservation:
    tool_id: str
    namespaced_name: str
    canonical_name: str
    plugin_name: Optional[str]
    description: str
    tool_type: str
    framework: str
    source: str
    index: int
    evidence_level: str
    runtime_registered: bool
    model_visible: bool
    executed: bool
    parameters: Optional[Any]
    return_parameter: Optional[Any]
    safe_metadata: Dict[str, Any]
    read_only_hint: Optional[bool]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SemanticKernelRuntimeSnapshot:
    framework: str
    runtime_name: Optional[str]
    evidence_level: str
    tools: List[SemanticKernelToolObservation]
    opaque_function_count: int = 0
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


def _safe_json(
    value: Any,
    depth: int = 0,
    secret_context: bool = False,
    seen: Optional[set[int]] = None,
) -> Any:
    if depth > 12:
        return None
    if seen is None:
        seen = set()
    if value is None or isinstance(value, (str, bool, int, float)):
        return "<redacted>" if secret_context and value is not None else value
    if isinstance(value, (list, tuple)):
        marker = id(value)
        if marker in seen:
            return None
        seen.add(marker)
        try:
            return [
                _safe_json(item, depth + 1, secret_context, seen)
                for item in value
            ]
        finally:
            seen.remove(marker)
    if isinstance(value, Mapping):
        marker = id(value)
        if marker in seen:
            return None
        seen.add(marker)
        try:
            output: Dict[str, Any] = {}
            parameter_name = value.get("name")
            secret_parameter = (
                isinstance(parameter_name, str)
                and bool(_SECRET_KEY.search(parameter_name))
            )
            for key, item in value.items():
                if not isinstance(key, str):
                    continue
                child_secret = (
                    secret_context
                    or bool(_SECRET_KEY.search(key))
                    or (
                        secret_parameter
                        and key.lower() in _SECRET_PARAMETER_VALUE_KEYS
                    )
                )
                child = _safe_json(
                    item,
                    depth + 1,
                    child_secret,
                    seen,
                )
                if child is not None:
                    output[key] = child
            return output
        finally:
            seen.remove(marker)

    data = _instance_dict(value)
    if not data:
        return None
    return _safe_json(data, depth + 1, secret_context, seen)


def _stable_id(value: Any) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return "tool:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _plugins_from_input(value: Any) -> Iterable[Tuple[str, Any]]:
    if isinstance(value, Mapping):
        nested = value.get("plugins")
        if isinstance(nested, Mapping):
            return list(nested.items())
        return list(value.items())

    data = _instance_dict(value)
    plugins = data.get("plugins")
    if isinstance(plugins, Mapping):
        return list(plugins.items())
    return []


def _functions_from_plugin(plugin: Any) -> Iterable[Tuple[str, Any]]:
    if isinstance(plugin, Mapping):
        nested = plugin.get("functions")
        if isinstance(nested, Mapping):
            return list(nested.items())
        return list(plugin.items())

    data = _instance_dict(plugin)
    functions = data.get("functions")
    if isinstance(functions, Mapping):
        return list(functions.items())
    return []


def _metadata_from_function(function: Any) -> Optional[Mapping[str, Any]]:
    if isinstance(function, Mapping):
        nested = function.get("metadata")
        if isinstance(nested, Mapping):
            return nested
        if isinstance(function.get("name"), str):
            return function
        return None

    data = _instance_dict(function)
    metadata = data.get("metadata")
    metadata_data = _instance_dict(metadata)
    if metadata_data:
        return metadata_data
    if isinstance(data.get("name"), str):
        return data
    return None


def _parameter_list(value: Any) -> Optional[Any]:
    if value is None:
        return None
    return _safe_json(value)


def _observe_metadata(
    metadata: Mapping[str, Any],
    *,
    runtime_name: Optional[str],
    evidence_level: str,
    source: str,
    index: int,
    plugin_hint: Optional[str] = None,
) -> Optional[SemanticKernelToolObservation]:
    name = metadata.get("name")
    if not isinstance(name, str) or not name.strip():
        return None

    plugin_name = metadata.get("plugin_name")
    if not isinstance(plugin_name, str) or not plugin_name.strip():
        plugin_name = plugin_hint

    description = metadata.get("description")
    if not isinstance(description, str):
        description = ""

    parameters = _parameter_list(metadata.get("parameters"))
    return_parameter = _parameter_list(metadata.get("return_parameter"))

    safe_metadata: Dict[str, Any] = {}
    for key in ("is_prompt", "is_asynchronous"):
        value = metadata.get(key)
        if isinstance(value, bool):
            safe_metadata[key] = value

    fq_name = f"{plugin_name}-{name}" if plugin_name else name
    namespace = f"semantic-kernel/{runtime_name or 'runtime'}"
    identity = {
        "framework": "semantic-kernel",
        "namespace": namespace,
        "plugin": plugin_name,
        "name": name,
        "description": description,
        "parameters": parameters,
        "return_parameter": return_parameter,
    }

    return SemanticKernelToolObservation(
        tool_id=_stable_id(identity),
        namespaced_name=f"{namespace}/{fq_name}",
        canonical_name=fq_name,
        plugin_name=plugin_name,
        description=description,
        tool_type="kernel_function",
        framework="semantic-kernel",
        source=source,
        index=index,
        evidence_level=evidence_level,
        runtime_registered=True,
        model_visible=evidence_level == "MODEL_VISIBLE",
        executed=False,
        parameters=parameters,
        return_parameter=return_parameter,
        safe_metadata=safe_metadata,
        read_only_hint=True if _READ_ONLY_NAME.search(name) else None,
    )


def discover_semantic_kernel_registered_tools(
    kernel_or_plugins: Any,
    runtime_name: Optional[str] = None,
) -> SemanticKernelRuntimeSnapshot:
    """Observe already-registered Kernel plugins/functions without invoking SK."""
    tools: List[SemanticKernelToolObservation] = []
    opaque = 0
    index = 0

    for plugin_key, plugin in _plugins_from_input(kernel_or_plugins):
        plugin_data = _instance_dict(plugin)
        plugin_name = plugin_data.get("name")
        if not isinstance(plugin_name, str) or not plugin_name.strip():
            plugin_name = plugin_key if isinstance(plugin_key, str) else None

        functions = list(_functions_from_plugin(plugin))
        if not functions and plugin:
            opaque += 1

        for _function_key, function in functions:
            metadata = _metadata_from_function(function)
            if metadata is None:
                opaque += 1
                continue
            observed = _observe_metadata(
                metadata,
                runtime_name=runtime_name,
                evidence_level="RUNTIME_REGISTERED",
                source="semantic_kernel.kernel.plugins",
                index=index,
                plugin_hint=plugin_name,
            )
            index += 1
            if observed is not None:
                tools.append(observed)

    return SemanticKernelRuntimeSnapshot(
        framework="semantic-kernel",
        runtime_name=runtime_name,
        evidence_level="RUNTIME_REGISTERED",
        tools=tools,
        opaque_function_count=opaque,
    )


def _visible_items(value: Any) -> Iterable[Any]:
    if isinstance(value, (list, tuple)):
        return value
    if isinstance(value, Mapping):
        tools = value.get("tools")
        if isinstance(tools, (list, tuple)):
            return tools
        functions = value.get("functions")
        if isinstance(functions, (list, tuple)):
            return functions
        return [value] if isinstance(value.get("name"), str) else []

    data = _instance_dict(value)
    for key in ("tools", "functions"):
        items = data.get(key)
        if isinstance(items, (list, tuple)):
            return items
    return []


def _openai_function_metadata(value: Any) -> Optional[Mapping[str, Any]]:
    data = _instance_dict(value)
    if not data:
        return None
    if data.get("type") != "function":
        return None
    function = data.get("function")
    function_data = _instance_dict(function)
    if not function_data:
        return None
    name = function_data.get("name")
    if not isinstance(name, str):
        return None

    return {
        "name": name,
        "description": function_data.get("description", ""),
        "parameters": function_data.get("parameters"),
    }


def discover_semantic_kernel_model_visible_tools(
    function_metadata_or_tools: Any,
    runtime_name: Optional[str] = None,
) -> SemanticKernelRuntimeSnapshot:
    """Observe an already-filtered/model-bound Semantic Kernel tool payload.

    Callers should pass the function metadata/tool definitions after any
    FunctionChoiceBehavior filtering has already happened. This helper never
    evaluates that behavior or asks the Kernel for a filtered list.
    """
    tools: List[SemanticKernelToolObservation] = []
    opaque = 0

    for index, raw in enumerate(_visible_items(function_metadata_or_tools)):
        metadata = _openai_function_metadata(raw)
        if metadata is None:
            metadata = _metadata_from_function(raw)
        if metadata is None:
            opaque += 1
            continue

        observed = _observe_metadata(
            metadata,
            runtime_name=runtime_name,
            evidence_level="MODEL_VISIBLE",
            source="semantic_kernel.model_visible.functions",
            index=index,
        )
        if observed is not None:
            tools.append(observed)

    return SemanticKernelRuntimeSnapshot(
        framework="semantic-kernel",
        runtime_name=runtime_name,
        evidence_level="MODEL_VISIBLE",
        tools=tools,
        opaque_function_count=opaque,
    )

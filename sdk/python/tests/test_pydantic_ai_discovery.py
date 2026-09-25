import json
import unittest

from once_agent.discovery import (
    discover_pydantic_ai_model_visible_tools,
    discover_pydantic_ai_registered_tools,
)


class ExplosiveTool:
    def __init__(self) -> None:
        self.name = "send_email"
        self.description = "Send an external customer email"
        self.parameters_json_schema = {
            "type": "object",
            "properties": {
                "to": {"type": "string"},
                "api_key": {
                    "type": "string",
                    "default": "schema-secret-must-not-leak",
                },
            },
        }
        self.kind = "function"
        self.strict = True
        self.metadata = {
            "team": "billing",
            "authorization": "Bearer metadata-secret-must-not-leak",
        }
        self.invoke_count = 0

    def __call__(self, *args, **kwargs):
        self.invoke_count += 1
        raise AssertionError("discovery must not execute the tool")

    @property
    def prepare(self):
        raise AssertionError("discovery must not evaluate prepare hooks")


class ExplosiveToolset:
    def __init__(self, tools):
        self.tools = tools
        self.calls = 0

    def get_tools(self, *args, **kwargs):
        self.calls += 1
        raise AssertionError("discovery must not call get_tools")


class ToolDefinition:
    def __init__(self, name, description, schema, **extra):
        self.name = name
        self.description = description
        self.parameters_json_schema = schema
        self.kind = extra.pop("kind", "function")
        for key, value in extra.items():
            setattr(self, key, value)


class ModelRequestParameters:
    def __init__(self, tools):
        self.function_tools = tools

    @property
    def secret(self):
        raise AssertionError("discovery must not walk unrelated properties")


class GetterOnlyTool:
    @property
    def name(self):
        raise AssertionError("discovery must not evaluate tool getters")


class PydanticAIDiscoveryTests(unittest.TestCase):
    def test_registered_toolset_is_observed_without_execution(self):
        tool = ExplosiveTool()
        toolset = ExplosiveToolset({"send_email": tool})

        snapshot = discover_pydantic_ai_registered_tools(
            toolset,
            "payments-agent",
        )

        self.assertEqual(snapshot.framework, "pydantic-ai")
        self.assertEqual(snapshot.evidence_level, "RUNTIME_REGISTERED")
        self.assertEqual(len(snapshot.tools), 1)
        self.assertFalse(snapshot.external_calls_made)
        self.assertFalse(snapshot.tool_invocations_made)
        self.assertFalse(snapshot.secret_values_retained)
        self.assertEqual(toolset.calls, 0)
        self.assertEqual(tool.invoke_count, 0)

        observed = snapshot.tools[0]
        self.assertEqual(observed.canonical_name, "send_email")
        self.assertEqual(observed.evidence_level, "RUNTIME_REGISTERED")
        self.assertFalse(observed.model_visible)
        self.assertTrue(observed.runtime_registered)
        self.assertFalse(observed.executed)
        self.assertEqual(observed.safe_metadata["strict"], True)
        self.assertEqual(observed.safe_metadata["metadata"]["team"], "billing")
        self.assertEqual(
            observed.safe_metadata["metadata"]["authorization"],
            "<redacted>",
        )
        self.assertEqual(
            observed.parameters_json_schema["properties"]["api_key"]["default"],
            "<redacted>",
        )

        serialized = json.dumps(snapshot.to_dict(), sort_keys=True)
        self.assertNotIn("schema-secret-must-not-leak", serialized)
        self.assertNotIn("metadata-secret-must-not-leak", serialized)

    def test_model_request_parameters_are_model_visible(self):
        tools = [
            ToolDefinition(
                "send_email",
                "Send an external customer email",
                {"type": "object", "properties": {"to": {"type": "string"}}},
                strict=True,
                sequential=True,
                toolset_id="billing",
            ),
            ToolDefinition(
                "web_search",
                "Search public information",
                {"type": "object", "properties": {"query": {"type": "string"}}},
            ),
        ]
        params = ModelRequestParameters(tools)

        snapshot = discover_pydantic_ai_model_visible_tools(
            params,
            "payments-agent",
        )

        self.assertEqual(snapshot.evidence_level, "MODEL_VISIBLE")
        self.assertEqual(len(snapshot.tools), 2)
        self.assertTrue(all(tool.model_visible for tool in snapshot.tools))
        self.assertTrue(all(tool.runtime_registered for tool in snapshot.tools))
        self.assertTrue(all(not tool.executed for tool in snapshot.tools))
        self.assertEqual(snapshot.tools[0].safe_metadata["toolset_id"], "billing")
        self.assertEqual(snapshot.tools[1].read_only_hint, True)

    def test_direct_tool_definition_list_is_supported(self):
        visible = discover_pydantic_ai_model_visible_tools(
            [
                {
                    "name": "create_invoice",
                    "description": "Create a customer invoice",
                    "parameters_json_schema": {"type": "object"},
                    "kind": "function",
                    "metadata": {"token": "secret-must-not-leak"},
                }
            ]
        )

        self.assertEqual(len(visible.tools), 1)
        self.assertEqual(visible.tools[0].canonical_name, "create_invoice")
        self.assertEqual(
            visible.tools[0].safe_metadata["metadata"]["token"],
            "<redacted>",
        )

    def test_getter_only_tools_are_skipped_without_evaluation(self):
        snapshot = discover_pydantic_ai_registered_tools([GetterOnlyTool()])
        self.assertEqual(snapshot.tools, [])

    def test_same_name_different_schema_keeps_distinct_identity(self):
        first = discover_pydantic_ai_model_visible_tools(
            [{
                "name": "send_email",
                "description": "Send email",
                "parameters_json_schema": {
                    "type": "object",
                    "properties": {"to": {"type": "string"}},
                },
            }]
        ).tools[0]
        second = discover_pydantic_ai_model_visible_tools(
            [{
                "name": "send_email",
                "description": "Send email",
                "parameters_json_schema": {
                    "type": "object",
                    "properties": {"channel": {"type": "string"}},
                },
            }]
        ).tools[0]

        self.assertNotEqual(first.tool_id, second.tool_id)


if __name__ == "__main__":
    unittest.main()

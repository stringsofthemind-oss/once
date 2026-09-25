import json
import unittest

from once_agent.google_adk_discovery import (
    discover_google_adk_model_visible_tools,
    discover_google_adk_registered_tools,
)


class FakeBaseTool:
    def __init__(self):
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
        self.strict = True
        self.run_count = 0
        self.process_count = 0

    async def run_async(self, *args, **kwargs):
        self.run_count += 1
        raise AssertionError("discovery must not run ADK tools")

    async def process_llm_request(self, *args, **kwargs):
        self.process_count += 1
        raise AssertionError("discovery must not process an LLM request")


class FakeDynamicToolset:
    def __init__(self):
        self.calls = 0
        self.authorization = "Bearer toolset-secret-must-not-leak"

    async def get_tools(self, *args, **kwargs):
        self.calls += 1
        raise AssertionError("discovery must not resolve dynamic toolsets")

    async def list_tools(self, *args, **kwargs):
        self.calls += 1
        raise AssertionError("discovery must not list MCP tools")


class FakeAgent:
    def __init__(self, tools):
        self.tools = tools

    @property
    def canonical_tools(self):
        raise AssertionError("discovery must not resolve canonical tools")


class FakeFunctionDeclaration:
    def __init__(self, name, description, schema, **extra):
        self.name = name
        self.description = description
        self.parameters_json_schema = schema
        for key, value in extra.items():
            setattr(self, key, value)


class FakeGenAITool:
    def __init__(
        self,
        *,
        function_declarations=None,
        google_search=None,
        google_maps=None,
        url_context=None,
    ):
        self.function_declarations = function_declarations or []
        self.google_search = google_search
        self.google_maps = google_maps
        self.url_context = url_context
        self.authorization = "Bearer genai-secret-must-not-leak"


class FakeGenerateContentConfig:
    def __init__(self, tools):
        self.tools = tools

    @property
    def api_key(self):
        raise AssertionError("discovery must not walk unrelated config properties")


class FakeLlmRequest:
    def __init__(self, config):
        self.config = config
        self.tools_dict = {
            "send_email": object(),
        }

    @property
    def model(self):
        raise AssertionError("discovery must not touch model/provider properties")


class GetterOnlyTool:
    @property
    def name(self):
        raise AssertionError("discovery must not evaluate tool getters")


class GoogleADKDiscoveryTests(unittest.TestCase):
    def test_registered_tools_do_not_execute_or_resolve_toolsets(self):
        executed = {"count": 0}

        def get_weather(city: str):
            """Get the current weather for a city."""
            executed["count"] += 1
            raise AssertionError("registered discovery must not call functions")

        base_tool = FakeBaseTool()
        dynamic = FakeDynamicToolset()
        agent = FakeAgent([
            get_weather,
            base_tool,
            dynamic,
            GetterOnlyTool(),
        ])

        snapshot = discover_google_adk_registered_tools(
            agent,
            "support-agent",
        )

        self.assertEqual(snapshot.framework, "google-adk")
        self.assertEqual(snapshot.evidence_level, "RUNTIME_REGISTERED")
        self.assertEqual(len(snapshot.tools), 2)
        self.assertEqual(snapshot.opaque_tool_source_count, 1)
        self.assertFalse(snapshot.external_calls_made)
        self.assertFalse(snapshot.tool_invocations_made)
        self.assertFalse(snapshot.secret_values_retained)
        self.assertEqual(executed["count"], 0)
        self.assertEqual(base_tool.run_count, 0)
        self.assertEqual(base_tool.process_count, 0)
        self.assertEqual(dynamic.calls, 0)

        weather = next(
            tool for tool in snapshot.tools
            if tool.canonical_name == "get_weather"
        )
        self.assertEqual(weather.tool_type, "python_function")
        self.assertEqual(weather.read_only_hint, True)
        self.assertFalse(weather.model_visible)
        self.assertFalse(weather.executed)

        email = next(
            tool for tool in snapshot.tools
            if tool.canonical_name == "send_email"
        )
        self.assertEqual(email.evidence_level, "RUNTIME_REGISTERED")
        self.assertEqual(email.safe_metadata["strict"], True)
        self.assertEqual(
            email.parameters_json_schema["properties"]["api_key"]["default"],
            "<redacted>",
        )

        serialized = json.dumps(snapshot.to_dict(), sort_keys=True)
        self.assertNotIn("schema-secret-must-not-leak", serialized)
        self.assertNotIn("toolset-secret-must-not-leak", serialized)

    def test_built_llm_request_is_model_visible_without_touching_tools_dict(self):
        declaration = FakeFunctionDeclaration(
            "send_email",
            "Send an external customer email",
            {
                "type": "object",
                "properties": {
                    "to": {"type": "string"},
                    "token": {
                        "type": "string",
                        "default": "declaration-secret-must-not-leak",
                    },
                },
            },
            behavior="blocking",
        )
        config = FakeGenerateContentConfig([
            FakeGenAITool(function_declarations=[declaration]),
            FakeGenAITool(google_search={"internal": "must-not-be-traversed"}),
            FakeGenAITool(google_maps={"internal": "must-not-be-traversed"}),
        ])
        request = FakeLlmRequest(config)

        snapshot = discover_google_adk_model_visible_tools(
            request,
            "support-agent",
        )

        self.assertEqual(snapshot.evidence_level, "MODEL_VISIBLE")
        self.assertEqual(len(snapshot.tools), 3)
        self.assertTrue(all(tool.model_visible for tool in snapshot.tools))
        self.assertTrue(all(tool.runtime_registered for tool in snapshot.tools))
        self.assertTrue(all(not tool.executed for tool in snapshot.tools))

        email = next(
            tool for tool in snapshot.tools
            if tool.canonical_name == "send_email"
        )
        self.assertEqual(email.tool_type, "function")
        self.assertEqual(email.safe_metadata["behavior"], "blocking")
        self.assertEqual(
            email.parameters_json_schema["properties"]["token"]["default"],
            "<redacted>",
        )

        search = next(
            tool for tool in snapshot.tools
            if tool.canonical_name == "google_search"
        )
        maps = next(
            tool for tool in snapshot.tools
            if tool.canonical_name == "google_maps"
        )
        self.assertEqual(search.tool_type, "gemini_builtin")
        self.assertEqual(search.read_only_hint, True)
        self.assertEqual(maps.read_only_hint, True)

        serialized = json.dumps(snapshot.to_dict(), sort_keys=True)
        self.assertNotIn("declaration-secret-must-not-leak", serialized)
        self.assertNotIn("genai-secret-must-not-leak", serialized)
        self.assertNotIn("must-not-be-traversed", serialized)
        self.assertNotIn("tools_dict", serialized)

    def test_direct_generate_content_config_is_supported(self):
        config = FakeGenerateContentConfig([
            FakeGenAITool(url_context={"opaque": True}),
        ])
        snapshot = discover_google_adk_model_visible_tools(config)
        self.assertEqual(len(snapshot.tools), 1)
        self.assertEqual(snapshot.tools[0].canonical_name, "url_context")
        self.assertEqual(snapshot.tools[0].read_only_hint, True)

    def test_same_name_different_schema_keeps_distinct_identity(self):
        first = discover_google_adk_model_visible_tools([
            FakeGenAITool(function_declarations=[
                FakeFunctionDeclaration(
                    "send_email",
                    "Send email",
                    {
                        "type": "object",
                        "properties": {"to": {"type": "string"}},
                    },
                )
            ])
        ]).tools[0]
        second = discover_google_adk_model_visible_tools([
            FakeGenAITool(function_declarations=[
                FakeFunctionDeclaration(
                    "send_email",
                    "Send email",
                    {
                        "type": "object",
                        "properties": {"channel": {"type": "string"}},
                    },
                )
            ])
        ]).tools[0]

        self.assertNotEqual(first.tool_id, second.tool_id)


if __name__ == "__main__":
    unittest.main()

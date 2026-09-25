import json
import unittest

from once_agent.strands_discovery import (
    discover_strands_model_visible_tools,
    discover_strands_registered_tools,
)


class FakeRegistryMaterialization:
    def __init__(self, tools):
        self.tools = tools
        self.process_count = 0
        self.config_count = 0
        self.spec_count = 0

    def process_tools(self, *args, **kwargs):
        self.process_count += 1
        raise AssertionError("discovery must not load/process Strands tools")

    def get_all_tools_config(self):
        self.config_count += 1
        raise AssertionError("caller must materialize registry config before discovery")

    def get_all_tool_specs(self):
        self.spec_count += 1
        raise AssertionError("caller must materialize tool specs before discovery")


class GetterWrapper:
    @property
    def tools(self):
        raise AssertionError("discovery must not evaluate getter-backed tool config")


class StrandsDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.send_email_spec = {
            "name": "send_email",
            "description": "Send an external customer email",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": {"type": "string"},
                    "api_key": {
                        "type": "string",
                        "default": "schema-secret-must-not-leak",
                    },
                },
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": False,
                "openWorldHint": True,
                "authorization": "Bearer annotation-secret-must-not-leak",
            },
        }
        self.search_spec = {
            "name": "search_docs",
            "description": "Search documentation",
            "inputSchema": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
            },
            "annotations": {"readOnlyHint": True},
        }

    def test_registered_materialized_config_does_not_call_registry(self):
        registry = FakeRegistryMaterialization([
            {"toolSpec": self.send_email_spec},
            {"toolSpec": self.search_spec},
        ])

        snapshot = discover_strands_registered_tools(
            registry,
            "support-agent",
        )

        self.assertEqual(snapshot.framework, "strands")
        self.assertEqual(snapshot.evidence_level, "RUNTIME_REGISTERED")
        self.assertEqual(len(snapshot.tools), 2)
        self.assertFalse(snapshot.external_calls_made)
        self.assertFalse(snapshot.tool_invocations_made)
        self.assertFalse(snapshot.secret_values_retained)
        self.assertEqual(registry.process_count, 0)
        self.assertEqual(registry.config_count, 0)
        self.assertEqual(registry.spec_count, 0)

        email = next(tool for tool in snapshot.tools if tool.canonical_name == "send_email")
        search = next(tool for tool in snapshot.tools if tool.canonical_name == "search_docs")

        self.assertFalse(email.model_visible)
        self.assertFalse(email.executed)
        self.assertEqual(email.safe_annotations["readOnlyHint"], False)
        self.assertEqual(search.read_only_hint, True)
        self.assertEqual(
            email.input_schema["properties"]["api_key"]["default"],
            "<redacted>",
        )

        serialized = json.dumps(snapshot.to_dict(), sort_keys=True)
        self.assertNotIn("schema-secret-must-not-leak", serialized)
        self.assertNotIn("annotation-secret-must-not-leak", serialized)
        self.assertNotIn("authorization", serialized)

    def test_model_tool_config_is_model_visible(self):
        tool_config = {
            "tools": [
                {"toolSpec": self.send_email_spec},
                {"toolSpec": self.search_spec},
            ],
            "toolChoice": {"auto": {}},
            "authorization": "Bearer request-secret-must-not-leak",
        }

        snapshot = discover_strands_model_visible_tools(
            tool_config,
            "support-agent",
        )

        self.assertEqual(snapshot.evidence_level, "MODEL_VISIBLE")
        self.assertEqual(len(snapshot.tools), 2)
        self.assertTrue(all(tool.model_visible for tool in snapshot.tools))
        self.assertTrue(all(tool.runtime_registered for tool in snapshot.tools))
        self.assertTrue(all(not tool.executed for tool in snapshot.tools))

        serialized = json.dumps(snapshot.to_dict(), sort_keys=True)
        self.assertNotIn("request-secret-must-not-leak", serialized)
        self.assertNotIn("toolChoice", serialized)

    def test_direct_tool_specs_are_supported(self):
        snapshot = discover_strands_registered_tools([
            self.send_email_spec,
            self.search_spec,
        ])
        self.assertEqual(len(snapshot.tools), 2)

    def test_getter_backed_config_is_ignored(self):
        snapshot = discover_strands_registered_tools(GetterWrapper())
        self.assertEqual(snapshot.tools, [])

    def test_same_name_different_schema_keeps_distinct_identity(self):
        first = discover_strands_model_visible_tools([
            {"toolSpec": {
                "name": "send_email",
                "description": "Send email",
                "inputSchema": {
                    "type": "object",
                    "properties": {"to": {"type": "string"}},
                },
            }}
        ]).tools[0]
        second = discover_strands_model_visible_tools([
            {"toolSpec": {
                "name": "send_email",
                "description": "Send email",
                "inputSchema": {
                    "type": "object",
                    "properties": {"channel": {"type": "string"}},
                },
            }}
        ]).tools[0]

        self.assertNotEqual(first.tool_id, second.tool_id)


if __name__ == "__main__":
    unittest.main()

import json
import unittest

from once_agent.additional_framework_adapters import (
    discover_agno_model_visible_tools,
    discover_agno_registered_tools,
    discover_crewai_model_visible_tools,
    discover_crewai_registered_tools,
    discover_llamaindex_model_visible_tools,
    discover_llamaindex_registered_tools,
    observe_agno_execution,
    observe_crewai_execution,
    observe_llamaindex_execution,
)


class Bag:
    def __init__(self, **values):
        self.__dict__.update(values)


class GetterTrap:
    @property
    def tools(self):
        raise AssertionError("adapter must not evaluate getters")


class CrewTool:
    def __init__(self):
        self.name = "send_email"
        self.description = "Send an external customer email"
        self.args_schema = {
            "type": "object",
            "properties": {
                "to": {"type": "string"},
                "api_key": {"type": "string", "default": "crew-secret"},
            },
        }
        self.result_as_answer = False
        self.calls = 0

    def _run(self, **_kwargs):
        self.calls += 1
        raise AssertionError("discovery must not invoke CrewAI tools")


class AgnoToolkit:
    def __init__(self):
        self.functions = {
            "charge_card": {
                "description": "Charge a customer card",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "amount": {"type": "string"},
                        "token": {"default": "agno-secret"},
                    },
                },
                "requires_confirmation": True,
            }
        }
        self.calls = 0

    def get_tools(self):
        self.calls += 1
        raise AssertionError("discovery must not resolve Agno toolkits")


class OpaqueAgnoFactory:
    def __init__(self):
        self.calls = 0

    def get_tools(self):
        self.calls += 1
        raise AssertionError("discovery must not resolve Agno factories")


class AdditionalFrameworkAdapterTests(unittest.TestCase):
    def test_crewai_registered_and_model_visible_are_read_only(self):
        tool = CrewTool()
        agent = Bag(tools=[tool, GetterTrap()])

        registered = discover_crewai_registered_tools(agent, "support-agent")

        self.assertEqual(registered.framework, "crewai")
        self.assertEqual(registered.evidence_level, "RUNTIME_REGISTERED")
        self.assertEqual(len(registered.tools), 1)
        self.assertEqual(tool.calls, 0)
        self.assertFalse(registered.external_calls_made)
        self.assertFalse(registered.tool_invocations_made)

        observed = registered.tools[0]
        self.assertEqual(observed.canonical_name, "send_email")
        self.assertFalse(observed.model_visible)
        self.assertEqual(
            observed.parameters_json_schema["properties"]["api_key"]["default"],
            "<redacted>",
        )

        visible = discover_crewai_model_visible_tools(
            [
                {
                    "type": "function",
                    "function": {
                        "name": "send_email",
                        "description": "Send an external customer email",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "to": {"type": "string"},
                                "authorization": {"default": "visible-secret"},
                            },
                        },
                    },
                }
            ],
            "support-agent",
        )
        self.assertEqual(visible.evidence_level, "MODEL_VISIBLE")
        self.assertTrue(visible.tools[0].model_visible)
        self.assertNotIn(
            "visible-secret",
            json.dumps(visible.to_dict(), sort_keys=True),
        )

    def test_crewai_terminal_events_become_secret_minimal_execution_evidence(self):
        tool = discover_crewai_registered_tools(
            [CrewTool()],
            "support-agent",
        ).tools[0]

        succeeded = observe_crewai_execution(
            Bag(
                type="tool_usage_finished",
                tool_name="send_email",
                output="customer-secret-result",
                tool_args={"api_key": "must-not-leak"},
                failure=None,
            ),
            tool,
        )
        self.assertIsNotNone(succeeded)
        self.assertEqual(succeeded.status, "SUCCEEDED")
        serialized = json.dumps(succeeded.to_dict(), sort_keys=True)
        self.assertNotIn("customer-secret-result", serialized)
        self.assertNotIn("must-not-leak", serialized)

        failed = observe_crewai_execution(
            Bag(
                type="tool_usage_error",
                tool_name="send_email",
                error="provider-secret-error",
            ),
            tool,
        )
        self.assertEqual(failed.status, "FAILED")
        self.assertNotIn(
            "provider-secret-error",
            json.dumps(failed.to_dict(), sort_keys=True),
        )

    def test_llamaindex_metadata_is_observed_without_serializer_calls(self):
        metadata = Bag(
            name="book_trip",
            description="Book a customer trip",
            return_direct=True,
            api_key="metadata-secret",
        )
        tool = Bag(_metadata=metadata)

        registered = discover_llamaindex_registered_tools(
            [tool],
            "travel-agent",
        )
        self.assertEqual(len(registered.tools), 1)
        observed = registered.tools[0]
        self.assertEqual(observed.canonical_name, "book_trip")
        self.assertEqual(observed.safe_metadata["return_direct"], True)
        self.assertIsNone(observed.parameters_json_schema)
        self.assertNotIn(
            "metadata-secret",
            json.dumps(registered.to_dict(), sort_keys=True),
        )

        visible = discover_llamaindex_model_visible_tools(
            {
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "book_trip",
                            "description": "Book a customer trip",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "destination": {"type": "string"},
                                    "password": {"default": "schema-secret"},
                                },
                            },
                        },
                    }
                ]
            },
            "travel-agent",
        )
        self.assertEqual(visible.evidence_level, "MODEL_VISIBLE")
        self.assertTrue(visible.tools[0].model_visible)
        self.assertNotIn(
            "schema-secret",
            json.dumps(visible.to_dict(), sort_keys=True),
        )

    def test_llamaindex_tool_call_result_maps_status_without_retaining_payload(self):
        tool = discover_llamaindex_model_visible_tools(
            [
                {
                    "type": "function",
                    "function": {
                        "name": "book_trip",
                        "description": "Book trip",
                        "parameters": {"type": "object"},
                    },
                }
            ],
            "travel-agent",
        ).tools[0]

        succeeded = observe_llamaindex_execution(
            Bag(
                tool_name="book_trip",
                tool_id="transport-call-7",
                tool_kwargs={"password": "must-not-leak"},
                tool_output=Bag(
                    is_error=False,
                    raw_output="booking-secret",
                    raw_input={"token": "must-not-leak"},
                ),
            ),
            tool,
        )
        self.assertEqual(succeeded.status, "SUCCEEDED")
        serialized = json.dumps(succeeded.to_dict(), sort_keys=True)
        self.assertNotIn("transport-call-7", serialized)
        self.assertNotIn("booking-secret", serialized)
        self.assertNotIn("must-not-leak", serialized)

        failed = observe_llamaindex_execution(
            Bag(
                tool_name="book_trip",
                tool_output=Bag(is_error=True, raw_output="private failure"),
            ),
            tool,
        )
        self.assertEqual(failed.status, "FAILED")

        unknown = observe_llamaindex_execution(
            Bag(tool_name="book_trip", tool_output=Bag(raw_output="opaque")),
            tool,
        )
        self.assertEqual(unknown.status, "UNKNOWN")

    def test_agno_materialized_toolkit_functions_are_observed_without_resolution(self):
        toolkit = AgnoToolkit()
        opaque = OpaqueAgnoFactory()
        agent = Bag(tools=[toolkit, opaque])

        registered = discover_agno_registered_tools(agent, "billing-agent")

        self.assertEqual(registered.framework, "agno")
        self.assertEqual(len(registered.tools), 1)
        self.assertEqual(registered.opaque_tool_source_count, 1)
        self.assertEqual(toolkit.calls, 0)
        self.assertEqual(opaque.calls, 0)

        tool = registered.tools[0]
        self.assertEqual(tool.canonical_name, "charge_card")
        self.assertEqual(tool.safe_metadata["requires_confirmation"], True)
        self.assertNotIn(
            "agno-secret",
            json.dumps(registered.to_dict(), sort_keys=True),
        )

        visible = discover_agno_model_visible_tools(
            {
                "functions": {
                    "charge_card": {
                        "description": "Charge a customer card",
                        "parameters": {
                            "type": "object",
                            "properties": {"amount": {"type": "string"}},
                        },
                    }
                }
            },
            "billing-agent",
        )
        self.assertEqual(len(visible.tools), 1)
        self.assertTrue(visible.tools[0].model_visible)

    def test_agno_completed_and_error_events_ignore_tool_call_id_and_payloads(self):
        tool = discover_agno_model_visible_tools(
            {
                "functions": {
                    "charge_card": {
                        "description": "Charge card",
                        "parameters": {"type": "object"},
                    }
                }
            },
            "billing-agent",
        ).tools[0]

        completed = observe_agno_execution(
            Bag(
                event="ToolCallCompleted",
                tool=Bag(
                    tool_name="charge_card",
                    tool_call_id="call_5",
                    tool_args={"token": "must-not-leak"},
                    tool_call_error=False,
                    result="processor-secret-result",
                ),
            ),
            tool,
        )
        self.assertEqual(completed.status, "SUCCEEDED")
        self.assertFalse(completed.transport_call_id_retained)
        serialized = json.dumps(completed.to_dict(), sort_keys=True)
        self.assertNotIn("call_5", serialized)
        self.assertNotIn("must-not-leak", serialized)
        self.assertNotIn("processor-secret-result", serialized)

        errored = observe_agno_execution(
            Bag(
                event="ToolCallError",
                error="private provider error",
                tool=Bag(
                    tool_name="charge_card",
                    tool_call_id="call_7",
                    tool_call_error=True,
                ),
            ),
            tool,
        )
        self.assertEqual(errored.status, "FAILED")
        self.assertNotIn(
            "private provider error",
            json.dumps(errored.to_dict(), sort_keys=True),
        )

    def test_exact_descriptor_binding_prevents_name_only_collision(self):
        first = discover_agno_model_visible_tools(
            [
                {
                    "type": "function",
                    "function": {
                        "name": "update_record",
                        "description": "Update account A",
                        "parameters": {
                            "type": "object",
                            "properties": {"a": {"type": "string"}},
                        },
                    },
                }
            ],
            "ops",
        ).tools[0]
        second = discover_agno_model_visible_tools(
            [
                {
                    "type": "function",
                    "function": {
                        "name": "update_record",
                        "description": "Update account B",
                        "parameters": {
                            "type": "object",
                            "properties": {"b": {"type": "string"}},
                        },
                    },
                }
            ],
            "ops",
        ).tools[0]

        self.assertNotEqual(first.tool_id, second.tool_id)
        self.assertNotEqual(
            first.descriptor_fingerprint,
            second.descriptor_fingerprint,
        )

        event = Bag(
            event="ToolCallCompleted",
            tool=Bag(tool_name="different_tool", tool_call_error=False),
        )
        self.assertIsNone(observe_agno_execution(event, first))

    def test_dynamic_registered_sources_fail_closed_without_invocation(self):
        factory_calls = {"count": 0}

        def tool_factory():
            factory_calls["count"] += 1
            raise AssertionError("dynamic tool factory must not run")

        snapshot = discover_agno_registered_tools(
            Bag(tools=tool_factory),
            "dynamic-agent",
        )
        self.assertEqual(snapshot.tools, [])
        self.assertEqual(snapshot.opaque_tool_source_count, 1)
        self.assertEqual(factory_calls["count"], 0)


if __name__ == "__main__":
    unittest.main()

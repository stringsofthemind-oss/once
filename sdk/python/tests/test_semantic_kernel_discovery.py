import json
import unittest

from once_agent.semantic_kernel_discovery import (
    discover_semantic_kernel_model_visible_tools,
    discover_semantic_kernel_registered_tools,
)


class Parameter:
    def __init__(self, name, description="", default_value=None, is_required=False):
        self.name = name
        self.description = description
        self.default_value = default_value
        self.is_required = is_required
        self.type_ = "str"

    @property
    def annotation(self):
        raise AssertionError("discovery must not evaluate parameter properties")


class Metadata:
    def __init__(
        self,
        name,
        plugin_name,
        description,
        parameters=None,
        *,
        is_prompt=False,
        is_asynchronous=True,
    ):
        self.name = name
        self.plugin_name = plugin_name
        self.description = description
        self.parameters = parameters or []
        self.return_parameter = None
        self.is_prompt = is_prompt
        self.is_asynchronous = is_asynchronous
        self.authorization = "Bearer metadata-secret-must-not-leak"

    @property
    def fully_qualified_name(self):
        raise AssertionError("discovery must not evaluate metadata properties")


class KernelFunction:
    def __init__(self, metadata):
        self.metadata = metadata
        self.invoke_count = 0
        self.client = {"api_key": "function-secret-must-not-leak"}

    async def invoke(self, *args, **kwargs):
        self.invoke_count += 1
        raise AssertionError("discovery must not invoke KernelFunction")

    @property
    def name(self):
        raise AssertionError("discovery must not evaluate function properties")


class Plugin:
    def __init__(self, name, functions):
        self.name = name
        self.description = "plugin description"
        self.functions = functions
        self.token = "plugin-secret-must-not-leak"
        self.metadata_calls = 0

    def get_functions_metadata(self):
        self.metadata_calls += 1
        raise AssertionError("discovery must not call plugin metadata methods")


class Kernel:
    def __init__(self, plugins):
        self.plugins = plugins
        self.services = {"default": {"api_key": "service-secret-must-not-leak"}}
        self.filter_calls = 0

    def get_list_of_function_metadata(self, *args, **kwargs):
        self.filter_calls += 1
        raise AssertionError("discovery must not evaluate function-choice filters")

    async def invoke(self, *args, **kwargs):
        raise AssertionError("discovery must not invoke Kernel")


class SemanticKernelDiscoveryTests(unittest.TestCase):
    def test_registered_kernel_plugins_are_observed_without_invocation(self):
        email = KernelFunction(
            Metadata(
                "send_email",
                "Customer",
                "Send an external customer email",
                [
                    Parameter("to", "Destination"),
                    Parameter(
                        "api_key",
                        "Provider credential",
                        "parameter-secret-must-not-leak",
                    ),
                ],
            )
        )
        search = KernelFunction(
            Metadata(
                "search_orders",
                "Orders",
                "Search existing orders",
                [Parameter("query")],
            )
        )
        customer = Plugin("Customer", {"send_email": email})
        orders = Plugin("Orders", {"search_orders": search})
        kernel = Kernel({"Customer": customer, "Orders": orders})

        snapshot = discover_semantic_kernel_registered_tools(
            kernel,
            "support-agent",
        )

        self.assertEqual(snapshot.framework, "semantic-kernel")
        self.assertEqual(snapshot.evidence_level, "RUNTIME_REGISTERED")
        self.assertEqual(len(snapshot.tools), 2)
        self.assertFalse(snapshot.external_calls_made)
        self.assertFalse(snapshot.tool_invocations_made)
        self.assertFalse(snapshot.secret_values_retained)
        self.assertEqual(email.invoke_count, 0)
        self.assertEqual(search.invoke_count, 0)
        self.assertEqual(customer.metadata_calls, 0)
        self.assertEqual(orders.metadata_calls, 0)
        self.assertEqual(kernel.filter_calls, 0)

        email_observation = next(
            item for item in snapshot.tools
            if item.canonical_name == "Customer-send_email"
        )
        self.assertFalse(email_observation.model_visible)
        self.assertTrue(email_observation.runtime_registered)
        self.assertFalse(email_observation.executed)
        self.assertEqual(email_observation.plugin_name, "Customer")
        self.assertEqual(email_observation.safe_metadata["is_asynchronous"], True)
        secret_parameter = next(
            item for item in email_observation.parameters
            if item["name"] == "api_key"
        )
        self.assertEqual(secret_parameter["default_value"], "<redacted>")

        search_observation = next(
            item for item in snapshot.tools
            if item.canonical_name == "Orders-search_orders"
        )
        self.assertEqual(search_observation.read_only_hint, True)

        serialized = json.dumps(snapshot.to_dict(), sort_keys=True)
        for secret in (
            "metadata-secret-must-not-leak",
            "function-secret-must-not-leak",
            "plugin-secret-must-not-leak",
            "service-secret-must-not-leak",
            "parameter-secret-must-not-leak",
        ):
            self.assertNotIn(secret, serialized)
        self.assertNotIn("authorization", serialized.lower())
        self.assertNotIn("client", serialized.lower())

    def test_already_filtered_metadata_is_model_visible(self):
        visible = discover_semantic_kernel_model_visible_tools(
            [
                Metadata(
                    "send_email",
                    "Customer",
                    "Send an external customer email",
                    [Parameter("to")],
                ),
                Metadata(
                    "get_customer",
                    "Customer",
                    "Get a customer record",
                    [Parameter("customer_id")],
                ),
            ],
            "support-agent",
        )

        self.assertEqual(visible.evidence_level, "MODEL_VISIBLE")
        self.assertEqual(len(visible.tools), 2)
        self.assertTrue(all(item.model_visible for item in visible.tools))
        self.assertTrue(all(item.runtime_registered for item in visible.tools))
        self.assertTrue(all(not item.executed for item in visible.tools))

        customer = next(
            item for item in visible.tools
            if item.canonical_name == "Customer-get_customer"
        )
        self.assertEqual(customer.read_only_hint, True)

    def test_openai_formatted_model_tool_is_supported_without_retaining_auth(self):
        snapshot = discover_semantic_kernel_model_visible_tools(
            {
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "create_invoice",
                            "description": "Create a customer invoice",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "customer_id": {"type": "string"},
                                    "token": {
                                        "type": "string",
                                        "default": "openai-tool-secret",
                                    },
                                },
                            },
                        },
                        "authorization": "Bearer outer-secret",
                    }
                ],
                "api_key": "request-secret",
            },
            "billing-agent",
        )

        self.assertEqual(len(snapshot.tools), 1)
        invoice = snapshot.tools[0]
        self.assertEqual(invoice.canonical_name, "create_invoice")
        self.assertEqual(invoice.evidence_level, "MODEL_VISIBLE")
        self.assertIsNone(invoice.read_only_hint)
        self.assertEqual(
            invoice.parameters["properties"]["token"]["default"],
            "<redacted>",
        )

        serialized = json.dumps(snapshot.to_dict(), sort_keys=True)
        self.assertNotIn("openai-tool-secret", serialized)
        self.assertNotIn("outer-secret", serialized)
        self.assertNotIn("request-secret", serialized)

    def test_same_name_different_safe_parameter_shapes_keep_distinct_identity(self):
        first = discover_semantic_kernel_model_visible_tools(
            [
                Metadata(
                    "send_email",
                    "Customer",
                    "Send email",
                    [Parameter("to")],
                )
            ],
            "agent",
        ).tools[0]
        second = discover_semantic_kernel_model_visible_tools(
            [
                Metadata(
                    "send_email",
                    "Customer",
                    "Send email",
                    [Parameter("channel")],
                )
            ],
            "agent",
        ).tools[0]

        self.assertNotEqual(first.tool_id, second.tool_id)

    def test_opaque_functions_are_counted_not_executed(self):
        plugin = Plugin("Opaque", {"mystery": object()})
        snapshot = discover_semantic_kernel_registered_tools(
            Kernel({"Opaque": plugin}),
            "agent",
        )
        self.assertEqual(snapshot.tools, [])
        self.assertEqual(snapshot.opaque_function_count, 1)
        self.assertEqual(plugin.metadata_calls, 0)


if __name__ == "__main__":
    unittest.main()

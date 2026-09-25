import assert from "node:assert/strict";

import {
  GatewayConnectionError,
  connectOpenAIAgentsFunctionToolsGatewayAuto,
  planGatewayToolset,
} from "../dist/gateway/index.js";

console.log("");
console.log("ONCE PHASE 11E OPENAI FUNCTIONTOOL GATEWAY REGRESSION");
console.log("=====================================================");

let searchCalls = 0;
let sendCalls = 0;

const searchTool = {
  type: "function",
  name: "search_orders",
  description: "Search customer orders",
  parameters: { type: "object" },
  marker: "preserve-search",
  async invoke(runContext, rawInput, details) {
    searchCalls += 1;
    return { runContext, rawInput, details };
  },
};

const sendTool = {
  type: "function",
  name: "send_email",
  description: "Sends an external customer email",
  parameters: {
    type: "object",
    properties: {
      idempotencyKey: { type: "string" },
      to: { type: "string" },
      body: { type: "string" },
    },
  },
  marker: "preserve-send",
  async invoke() {
    sendCalls += 1;
    return "sent";
  },
};

const gateway = connectOpenAIAgentsFunctionToolsGatewayAuto([
  searchTool,
  sendTool,
]);

assert.equal(gateway.plan.ready, true);
assert.deepEqual(
  gateway.plan.entries.map(entry => entry.route),
  ["DIRECT", "PROTECT"],
);
assert.equal(gateway.tools.length, 2);
assert.equal(gateway.tools[0].name, "search_orders");
assert.equal(gateway.tools[1].name, "send_email");
assert.equal(gateway.tools[0].marker, "preserve-search");
assert.equal(gateway.tools[1].marker, "preserve-send");
assert.notEqual(gateway.tools[0], searchTool);
assert.notEqual(gateway.tools[1], sendTool);
assert.equal(searchCalls, 0);
assert.equal(sendCalls, 0);
console.log("PASS - Gateway preserves the exact supplied FunctionTool subset and framework shape");

const context = { actor: "test" };
const details = { toolCall: { callId: "transport-call-a" } };
const raw = "not-json-and-that-is-fine-for-direct";
const direct = await gateway.tools[0].invoke(context, raw, details);
assert.equal(searchCalls, 1);
assert.deepEqual(direct, { runContext: context, rawInput: raw, details });
assert.equal(sendCalls, 0);
console.log("PASS - DIRECT FunctionTool keeps raw input/context/details and does not parse protected semantics");

assert.throws(
  () => connectOpenAIAgentsFunctionToolsGatewayAuto([
    {
      type: "function",
      name: "search_update_records",
      description: "Search and update records",
      parameters: { type: "object" },
      async invoke() {
        throw new Error("must not execute");
      },
    },
  ]),
  error =>
    error instanceof GatewayConnectionError &&
    error.code === "GATEWAY_BLOCKED",
);
console.log("PASS - unresolved FunctionTool subset blocks before Connect wrapping/execution");

assert.throws(
  () => connectOpenAIAgentsFunctionToolsGatewayAuto([
    {
      type: "web_search",
      name: "web_search",
      description: "Search the web",
      parameters: { type: "object" },
      async invoke() {
        throw new Error("unsupported tool must not execute");
      },
    },
  ]),
  error =>
    error instanceof GatewayConnectionError &&
    error.code === "UNSUPPORTED_OPENAI_GATEWAY_TOOL_TYPE",
);
console.log("PASS - non-FunctionTool OpenAI categories fail closed in the v1 adapter");

assert.throws(
  () => connectOpenAIAgentsFunctionToolsGatewayAuto([
    searchTool,
    { ...searchTool },
  ]),
  error =>
    error instanceof GatewayConnectionError &&
    error.code === "DUPLICATE_OPENAI_GATEWAY_TOOL_NAME",
);
console.log("PASS - duplicate FunctionTool names are rejected before mapping");

const plan = planGatewayToolset([
  {
    name: searchTool.name,
    description: searchTool.description,
    inputSchema: searchTool.parameters,
  },
  {
    name: sendTool.name,
    description: sendTool.description,
    inputSchema: sendTool.parameters,
  },
]);
const bindings = plan.entries.map((entry, index) => ({
  toolId: `tool:${index}`,
  namespacedName: `openai-agent/${entry.name}`,
  canonicalName: entry.name,
  descriptorFingerprint: entry.descriptorFingerprint,
  evidenceLevel: index === 1 ? "EXECUTED" : "MODEL_VISIBLE",
  protection: index === 1 ? "ONCE_HEALTHY" : "NONE",
}));

const boundGateway = connectOpenAIAgentsFunctionToolsGatewayAuto(
  [searchTool, sendTool],
  { toolGraphBindings: bindings },
);
assert.equal(boundGateway.binding?.ready, true);
assert.equal(boundGateway.tools.length, 2);
assert.equal(boundGateway.plan.entries[1].route, "PROTECT");
assert.equal(boundGateway.binding?.entries[1].route, "PROTECT");
console.log("PASS - exact Tool Graph binding cannot downgrade OpenAI PROTECT routing");

assert.throws(
  () => connectOpenAIAgentsFunctionToolsGatewayAuto(
    [searchTool, sendTool],
    {
      toolGraphBindings: [
        bindings[0],
        { ...bindings[1], descriptorFingerprint: "0".repeat(64) },
      ],
    },
  ),
  error =>
    error instanceof GatewayConnectionError &&
    error.code === "GATEWAY_TOOL_GRAPH_BLOCKED",
);
assert.equal(sendCalls, 0);
console.log("PASS - stale OpenAI Tool Graph binding blocks before protected tool execution");

assert.throws(
  () => connectOpenAIAgentsFunctionToolsGatewayAuto(
    [searchTool],
    {
      overrides: {
        missing_tool: {},
      },
    },
  ),
  error =>
    error instanceof GatewayConnectionError &&
    error.code === "UNDECLARED_OPENAI_GATEWAY_OVERRIDE",
);
console.log("PASS - undeclared OpenAI Gateway overrides fail closed");

console.log("phase11e OpenAI FunctionTool gateway regression: PASS");

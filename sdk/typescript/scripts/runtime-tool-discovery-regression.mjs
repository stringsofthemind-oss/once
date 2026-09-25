import assert from "node:assert/strict";

import {
  discoverOpenAIAgentRuntime,
  discoverOpenAIResponsesModelVisibleTools,
  mergeRuntimeToolEvidence,
} from "../dist/runtime-tool-discovery.js";

let invokeCount = 0;
let executeCount = 0;
let mcpListCount = 0;
let mcpConnectCount = 0;

const agent = {
  name: "Payments Assistant",
  tools: [
    {
      type: "function",
      name: "send_email",
      description: "Send a transactional email to a customer",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          body: { type: "string" },
        },
      },
      invoke() {
        invokeCount++;
        throw new Error("observer must not invoke tools");
      },
      execute() {
        executeCount++;
        throw new Error("observer must not execute tools");
      },
      apiKey: "agent-tool-secret-must-not-leak",
    },
    {
      type: "web_search",
      search_context_size: "medium",
      internalToken: "hosted-secret-must-not-leak",
    },
    {
      type: "shell",
      name: "shell",
      description: "Run a shell command",
      executor: {
        secret: "shell-secret-must-not-leak",
      },
    },
  ],
  mcpServers: [
    {
      name: "billing",
      authorization: "Bearer mcp-secret-must-not-leak",
      async listTools() {
        mcpListCount++;
        throw new Error("observer must not enumerate MCP implicitly");
      },
      async connect() {
        mcpConnectCount++;
        throw new Error("observer must not connect MCP implicitly");
      },
    },
  ],
  mcpConfig: {
    includeServerInToolNames: true,
    authorization: "mcp-config-secret-must-not-leak",
  },
};

const registered = discoverOpenAIAgentRuntime(agent);

assert.equal(registered.framework, "openai-agents");
assert.equal(registered.agentName, "Payments Assistant");
assert.equal(registered.registeredToolCount, 3);
assert.equal(registered.configuredMcpServerCount, 1);
assert.equal(registered.includeServerInToolNames, true);
assert.equal(registered.externalCallsMade, false);
assert.equal(registered.toolInvocationsMade, false);
assert.equal(registered.secretValuesRetained, false);
assert.equal(invokeCount, 0);
assert.equal(executeCount, 0);
assert.equal(mcpListCount, 0);
assert.equal(mcpConnectCount, 0);

const registeredEmail = registered.tools.find(
  tool => tool.canonicalName === "send_email",
);
assert.ok(registeredEmail);
assert.equal(registeredEmail.evidence.level, "RUNTIME_REGISTERED");
assert.equal(registeredEmail.visibility.runtimeRegistered, true);
assert.equal(registeredEmail.visibility.modelVisible, false);
assert.equal(registeredEmail.once.effectClass, "EXTERNAL_COMMUNICATION");

const registeredSearch = registered.tools.find(
  tool => tool.toolType === "web_search",
);
assert.ok(registeredSearch);
assert.equal(registeredSearch.once.effectClass, "READ_ONLY");
assert.equal(registeredSearch.once.actionPriority.band, "BYPASS");

const registeredSerialized = JSON.stringify(registered);
for (const secret of [
  "agent-tool-secret-must-not-leak",
  "hosted-secret-must-not-leak",
  "shell-secret-must-not-leak",
  "mcp-secret-must-not-leak",
  "mcp-config-secret-must-not-leak",
]) {
  assert.doesNotMatch(registeredSerialized, new RegExp(secret));
}
assert.doesNotMatch(registeredSerialized, /authorization/i);
assert.doesNotMatch(registeredSerialized, /apiKey/i);
assert.doesNotMatch(registeredSerialized, /executor/i);

const responsesRequest = {
  model: "gpt-5.6-luna",
  tools: [
    {
      type: "function",
      name: "send_email",
      description: "Send a transactional email to a customer",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          body: { type: "string" },
        },
      },
      strict: true,
      internalCredential: "responses-secret-must-not-leak",
    },
    {
      type: "web_search",
    },
    {
      type: "mcp",
      server_label: "crm",
      server_url: "https://secret.example.invalid/mcp?token=must-not-leak",
      authorization: "Bearer hosted-mcp-secret-must-not-leak",
      defer_loading: true,
    },
  ],
  apiKey: "request-secret-must-not-leak",
};

const visible = discoverOpenAIResponsesModelVisibleTools(responsesRequest);

assert.equal(visible.framework, "openai-responses");
assert.equal(visible.modelVisibleToolCount, 3);
assert.equal(visible.externalCallsMade, false);
assert.equal(visible.toolInvocationsMade, false);
assert.equal(visible.secretValuesRetained, false);

const visibleEmail = visible.tools.find(
  tool => tool.canonicalName === "send_email",
);
assert.ok(visibleEmail);
assert.equal(visibleEmail.evidence.level, "MODEL_VISIBLE");
assert.equal(visibleEmail.visibility.runtimeRegistered, true);
assert.equal(visibleEmail.visibility.modelVisible, true);
assert.ok(
  visibleEmail.once.actionPriority.score >=
    registeredEmail.once.actionPriority.score,
  "stronger MODEL_VISIBLE evidence should not reduce action priority",
);

const hostedMcp = visible.tools.find(
  tool => tool.toolType === "mcp",
);
assert.ok(hostedMcp);
assert.equal(hostedMcp.canonicalName, "mcp:crm");
assert.deepEqual(hostedMcp.safeMetadata, {
  serverLabel: "crm",
  deferLoading: true,
});

const visibleSerialized = JSON.stringify(visible);
for (const secretFragment of [
  "responses-secret-must-not-leak",
  "secret.example.invalid",
  "must-not-leak",
  "hosted-mcp-secret-must-not-leak",
  "request-secret-must-not-leak",
]) {
  assert.doesNotMatch(visibleSerialized, new RegExp(secretFragment));
}
assert.doesNotMatch(visibleSerialized, /server_url/i);
assert.doesNotMatch(visibleSerialized, /authorization/i);
assert.doesNotMatch(visibleSerialized, /apiKey/i);

const secondAgent = discoverOpenAIAgentRuntime({
  name: "Internal Assistant",
  tools: [
    {
      type: "function",
      name: "send_email",
      description: "Send an internal operations email",
      parameters: {
        type: "object",
        properties: {
          team: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  ],
});

const merged = mergeRuntimeToolEvidence(
  registered,
  secondAgent,
  visible,
);
const mergedEmails = merged.tools.filter(
  tool => tool.canonicalName === "send_email",
);
assert.equal(
  mergedEmails.length,
  2,
  "same-name tools with different safe descriptor shapes must not collapse",
);

const mergedVisibleEmail = mergedEmails.find(
  tool =>
    tool.description ===
    "Send a transactional email to a customer",
);
assert.ok(mergedVisibleEmail);
assert.equal(mergedVisibleEmail.evidence.level, "MODEL_VISIBLE");
assert.equal(mergedVisibleEmail.visibility.modelVisible, true);

const mergedInternalEmail = mergedEmails.find(
  tool =>
    tool.description ===
    "Send an internal operations email",
);
assert.ok(mergedInternalEmail);
assert.equal(
  mergedInternalEmail.evidence.level,
  "RUNTIME_REGISTERED",
);
assert.equal(mergedInternalEmail.visibility.modelVisible, false);

assert.equal(invokeCount, 0);
assert.equal(executeCount, 0);
assert.equal(mcpListCount, 0);
assert.equal(mcpConnectCount, 0);

console.log("runtime tool discovery regression: PASS");

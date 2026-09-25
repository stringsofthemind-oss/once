import assert from "node:assert/strict";

import {
  discoverVercelAiSdkRegisteredTools,
  discoverVercelAiSdkModelVisibleTools,
  mergeRuntimeToolEvidence,
} from "../dist/runtime-tool-discovery.js";

let executeCount = 0;
let getterCount = 0;

const opaqueSchema = Object.create({
  frameworkInternal: true,
});
Object.defineProperty(opaqueSchema, "shape", {
  enumerable: true,
  get() {
    getterCount++;
    throw new Error("observer must not inspect opaque schema getters");
  },
});

const dangerousGetterTool = {};
Object.defineProperty(dangerousGetterTool, "description", {
  enumerable: true,
  value: "A getter-backed tool that must remain inert",
});
Object.defineProperty(dangerousGetterTool, "execute", {
  enumerable: true,
  get() {
    getterCount++;
    throw new Error("observer must not read execute getters");
  },
});
Object.defineProperty(dangerousGetterTool, "inputSchema", {
  enumerable: true,
  get() {
    getterCount++;
    throw new Error("observer must not read schema getters");
  },
});

const toolSet = {
  send_email: {
    description: "Send a transactional email to a customer",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        body: { type: "string" },
        auth_token: {
          type: "string",
          default: "schema-secret-must-not-leak",
        },
      },
      required: ["to", "body"],
    },
    execute() {
      executeCount++;
      throw new Error("observer must not execute tools");
    },
    providerOptions: {
      apiKey: "provider-secret-must-not-leak",
      authorization: "Bearer provider-secret-must-not-leak",
    },
  },
  web_search: {
    description: "Search the public web",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    },
    execute() {
      executeCount++;
      throw new Error("observer must not execute tools");
    },
  },
  charge_customer: {
    description: "Charge a customer payment method",
    inputSchema: opaqueSchema,
    execute() {
      executeCount++;
      throw new Error("observer must not execute tools");
    },
    internalCredential: "charge-secret-must-not-leak",
  },
  provider_search: {
    type: "provider-defined",
    description: "Search provider-hosted documents",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    },
    providerOptions: {
      token: "hosted-secret-must-not-leak",
    },
  },
  dangerous_getter: dangerousGetterTool,
};

Object.defineProperty(toolSet, "ignored_accessor", {
  enumerable: true,
  get() {
    getterCount++;
    throw new Error("observer must not enumerate tool-set getters");
  },
});

const registered = discoverVercelAiSdkRegisteredTools(
  toolSet,
  "billing-agent",
);

assert.equal(registered.framework, "vercel-ai-sdk");
assert.equal(registered.runtimeName, "billing-agent");
assert.equal(registered.registeredToolCount, 5);
assert.equal(registered.externalCallsMade, false);
assert.equal(registered.toolInvocationsMade, false);
assert.equal(registered.secretValuesRetained, false);
assert.equal(executeCount, 0);
assert.equal(getterCount, 0);

const registeredEmail = registered.tools.find(
  tool => tool.canonicalName === "send_email",
);
assert.ok(registeredEmail);
assert.equal(registeredEmail.framework, "vercel-ai-sdk");
assert.equal(registeredEmail.evidence.level, "RUNTIME_REGISTERED");
assert.equal(registeredEmail.visibility.modelVisible, false);
assert.equal(registeredEmail.safeMetadata?.autoExecutable, true);
assert.equal(registeredEmail.once.effectClass, "EXTERNAL_COMMUNICATION");
assert.equal(
  registeredEmail.inputSchema?.properties?.auth_token?.default,
  "<redacted>",
);

const registeredSearch = registered.tools.find(
  tool => tool.canonicalName === "web_search",
);
assert.ok(registeredSearch);
assert.equal(registeredSearch.once.effectClass, "READ_ONLY");
assert.equal(registeredSearch.once.actionPriority.band, "BYPASS");

const charge = registered.tools.find(
  tool => tool.canonicalName === "charge_customer",
);
assert.ok(charge);
assert.equal(charge.inputSchema, undefined);
assert.equal(charge.safeMetadata?.schemaOpaque, true);
assert.equal(charge.once.effectClass, "MONEY_MOVEMENT");

const providerDefined = registered.tools.find(
  tool => tool.canonicalName === "provider_search",
);
assert.ok(providerDefined);
assert.equal(providerDefined.toolType, "provider-defined");
assert.equal(providerDefined.safeMetadata?.providerDefined, true);
assert.equal(providerDefined.safeMetadata?.autoExecutable, false);

const getterTool = registered.tools.find(
  tool => tool.canonicalName === "dangerous_getter",
);
assert.ok(getterTool);
assert.equal(getterTool.safeMetadata?.autoExecutable, false);
assert.equal(getterCount, 0);

const registeredSerialized = JSON.stringify(registered);
for (const secret of [
  "schema-secret-must-not-leak",
  "provider-secret-must-not-leak",
  "charge-secret-must-not-leak",
  "hosted-secret-must-not-leak",
]) {
  assert.doesNotMatch(registeredSerialized, new RegExp(secret));
}
assert.doesNotMatch(registeredSerialized, /providerOptions/);
assert.doesNotMatch(registeredSerialized, /internalCredential/);

const visible = discoverVercelAiSdkModelVisibleTools(
  {
    model: "provider/model",
    tools: toolSet,
    activeTools: ["send_email", "web_search"],
    headers: {
      authorization: "Bearer request-secret-must-not-leak",
    },
  },
  "billing-agent",
);

assert.equal(visible.framework, "vercel-ai-sdk");
assert.equal(visible.runtimeName, "billing-agent");
assert.equal(visible.activeToolFilterApplied, true);
assert.equal(visible.modelVisibleToolCount, 2);
assert.deepEqual(
  visible.tools.map(tool => tool.canonicalName).sort(),
  ["send_email", "web_search"],
);
assert.ok(
  visible.tools.every(tool => tool.evidence.level === "MODEL_VISIBLE"),
);
assert.ok(
  visible.tools.every(tool => tool.visibility.modelVisible),
);
assert.equal(executeCount, 0);
assert.equal(getterCount, 0);

const visibleSerialized = JSON.stringify(visible);
assert.doesNotMatch(visibleSerialized, /request-secret-must-not-leak/);
assert.doesNotMatch(visibleSerialized, /authorization/i);

const experimentalVisible = discoverVercelAiSdkModelVisibleTools(
  {
    tools: toolSet,
    experimental_activeTools: ["charge_customer"],
  },
  "billing-agent",
);
assert.equal(experimentalVisible.modelVisibleToolCount, 1);
assert.equal(
  experimentalVisible.tools[0]?.canonicalName,
  "charge_customer",
);

const merged = mergeRuntimeToolEvidence(registered, visible);
const mergedEmail = merged.tools.find(
  tool => tool.canonicalName === "send_email",
);
assert.ok(mergedEmail);
assert.equal(mergedEmail.evidence.level, "MODEL_VISIBLE");
assert.equal(mergedEmail.visibility.modelVisible, true);

const mergedCharge = merged.tools.find(
  tool => tool.canonicalName === "charge_customer",
);
assert.ok(mergedCharge);
assert.equal(mergedCharge.evidence.level, "RUNTIME_REGISTERED");

const sameNameDifferentSchema = discoverVercelAiSdkRegisteredTools(
  {
    send_email: {
      description: "Send a transactional email to a customer",
      inputSchema: {
        type: "object",
        properties: {
          templateId: { type: "string" },
        },
      },
    },
  },
  "different-agent",
);
const collisionSafe = mergeRuntimeToolEvidence(
  registered,
  sameNameDifferentSchema,
);
assert.equal(
  collisionSafe.tools.filter(tool => tool.canonicalName === "send_email").length,
  2,
  "same-name tools with different safe descriptor shapes must not collapse",
);

assert.equal(executeCount, 0);
assert.equal(getterCount, 0);

console.log("vercel runtime tool discovery regression: PASS");

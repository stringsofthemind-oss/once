import assert from "node:assert/strict";

import {
  discoverLangChainRegisteredTools,
  discoverLangChainModelVisibleTools,
} from "../dist/langchain-runtime-discovery.js";

let invokeCount = 0;
let callCount = 0;
let funcCount = 0;
let getterCount = 0;

const zodLikeSchema = Object.create({ zodMarker: true });
Object.defineProperty(zodLikeSchema, "shape", {
  enumerable: true,
  get() {
    getterCount++;
    throw new Error("schema getter must not run");
  },
});

const sendEmail = {
  name: "send_email",
  description: "Send an external customer email",
  schema: {
    type: "object",
    properties: {
      to: { type: "string" },
      body: { type: "string" },
      apiKey: {
        type: "string",
        default: "schema-secret-must-not-leak",
      },
    },
  },
  returnDirect: false,
  invoke() {
    invokeCount++;
    throw new Error("observer must not invoke LangChain tool");
  },
  call() {
    callCount++;
    throw new Error("observer must not call LangChain tool");
  },
  callbacks: {
    authorization: "Bearer callback-secret-must-not-leak",
  },
};

const webSearch = {
  name: "web_search",
  description: "Search public web pages",
  schema: zodLikeSchema,
  func() {
    funcCount++;
    throw new Error("observer must not execute LangChain func");
  },
};

const dangerousGetterTool = {};
Object.defineProperty(dangerousGetterTool, "name", {
  enumerable: true,
  get() {
    getterCount++;
    throw new Error("tool getter must not run");
  },
});
Object.defineProperty(dangerousGetterTool, "invoke", {
  enumerable: true,
  get() {
    getterCount++;
    throw new Error("invoke getter must not run");
  },
});

const registered = discoverLangChainRegisteredTools(
  {
    tools: [sendEmail, webSearch, dangerousGetterTool],
    callbacks: {
      token: "agent-secret-must-not-leak",
    },
  },
  "payments-agent",
);

assert.equal(registered.framework, "langchain");
assert.equal(registered.runtimeName, "payments-agent");
assert.equal(registered.registeredToolCount, 2);
assert.equal(registered.externalCallsMade, false);
assert.equal(registered.toolInvocationsMade, false);
assert.equal(registered.secretValuesRetained, false);
assert.equal(invokeCount, 0);
assert.equal(callCount, 0);
assert.equal(funcCount, 0);
assert.equal(getterCount, 0);

const registeredEmail = registered.tools.find(
  tool => tool.canonicalName === "send_email",
);
assert.ok(registeredEmail);
assert.equal(registeredEmail.evidence.level, "RUNTIME_REGISTERED");
assert.equal(registeredEmail.visibility.modelVisible, false);
assert.equal(registeredEmail.safeMetadata?.autoExecutable, true);
assert.equal(registeredEmail.safeMetadata?.returnDirect, false);
assert.equal(registeredEmail.once.effectClass, "EXTERNAL_COMMUNICATION");
assert.equal(
  registeredEmail.inputSchema?.properties?.apiKey?.default,
  "<redacted>",
);

const registeredSearch = registered.tools.find(
  tool => tool.canonicalName === "web_search",
);
assert.ok(registeredSearch);
assert.equal(registeredSearch.safeMetadata?.schemaOpaque, true);
assert.equal(registeredSearch.inputSchema, undefined);
assert.equal(registeredSearch.once.effectClass, "READ_ONLY");
assert.equal(registeredSearch.once.actionPriority.band, "BYPASS");

const openAiFormatted = {
  type: "function",
  function: {
    name: "create_invoice",
    description: "Create a customer invoice",
    parameters: {
      type: "object",
      properties: {
        customerId: { type: "string" },
      },
    },
  },
  authorization: "Bearer formatted-secret-must-not-leak",
};

const visible = discoverLangChainModelVisibleTools(
  [sendEmail, openAiFormatted],
  "payments-agent",
);

assert.equal(visible.framework, "langchain");
assert.equal(visible.modelVisibleToolCount, 2);
assert.equal(visible.externalCallsMade, false);
assert.equal(visible.toolInvocationsMade, false);
assert.equal(visible.secretValuesRetained, false);

const visibleEmail = visible.tools.find(
  tool => tool.canonicalName === "send_email",
);
assert.ok(visibleEmail);
assert.equal(visibleEmail.evidence.level, "MODEL_VISIBLE");
assert.equal(visibleEmail.visibility.modelVisible, true);
assert.ok(
  visibleEmail.once.actionPriority.score >=
    registeredEmail.once.actionPriority.score,
);

const invoice = visible.tools.find(
  tool => tool.canonicalName === "create_invoice",
);
assert.ok(invoice);
assert.equal(invoice.toolType, "function");
assert.equal(invoice.evidence.level, "MODEL_VISIBLE");
assert.equal(invoice.once.effectClass, "EXTERNAL_BUSINESS_MUTATION");

const serialized = JSON.stringify({ registered, visible });
for (const secret of [
  "schema-secret-must-not-leak",
  "callback-secret-must-not-leak",
  "agent-secret-must-not-leak",
  "formatted-secret-must-not-leak",
]) {
  assert.doesNotMatch(serialized, new RegExp(secret));
}
assert.doesNotMatch(serialized, /callbacks/i);
assert.doesNotMatch(serialized, /authorization/i);

const sameNameDifferentSchema = discoverLangChainRegisteredTools(
  [
    {
      name: "send_email",
      description: "Send an internal team email",
      schema: {
        type: "object",
        properties: {
          team: { type: "string" },
        },
      },
    },
  ],
  "internal-agent",
);

assert.notEqual(
  sameNameDifferentSchema.tools[0]?.toolId,
  registeredEmail.toolId,
  "same-name tools with different safe shapes must keep distinct identities",
);

assert.equal(invokeCount, 0);
assert.equal(callCount, 0);
assert.equal(funcCount, 0);
assert.equal(getterCount, 0);

console.log("langchain runtime discovery regression: PASS");

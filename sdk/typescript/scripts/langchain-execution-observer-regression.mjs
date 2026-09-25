import assert from "node:assert/strict";

import {
  aggregateToolExecutions,
  createLangChainExecutionObserver,
  discoverLangChainModelVisibleTools,
  promoteToolExecution,
} from "../dist/discovery/index.js";

console.log("");
console.log("ONCE PHASE 11D LANGCHAIN EXECUTION OBSERVER REGRESSION");
console.log("====================================================");

let invokeCount = 0;
const sendEmail = {
  name: "send_email",
  description: "Send an external customer email",
  schema: {
    type: "object",
    properties: {
      to: { type: "string" },
    },
  },
  async invoke() {
    invokeCount += 1;
    throw new Error("observer must never invoke LangChain tools");
  },
};
const searchOrders = {
  name: "search_orders",
  description: "Search existing orders",
  schema: { type: "object" },
  async invoke() {
    invokeCount += 1;
    throw new Error("observer must never invoke LangChain tools");
  },
};

const visible = discoverLangChainModelVisibleTools(
  [sendEmail, searchOrders],
  "support-graph",
);
assert.equal(visible.tools.length, 2);
assert.equal(invokeCount, 0);

const observer = createLangChainExecutionObserver(visible);
assert.equal(observer.name, "once-execution-observer");

let getterReads = 0;
const serializedEmail = {
  name: "send_email",
  id: ["langchain", "tools", "send_email"],
};
Object.defineProperty(serializedEmail, "credentials", {
  enumerable: true,
  get() {
    getterReads += 1;
    throw new Error("observer must not inspect arbitrary serialized fields");
  },
});

// handleToolStart(serialized, input, runId, parentRunId, tags, metadata, runName, toolCallId)
observer.handleToolStart(
  serializedEmail,
  JSON.stringify({
    to: "customer@example.com",
    api_key: "input-secret-must-not-leak",
  }),
  "run-1",
  "parent-1",
  ["secret-tag"],
  { token: "metadata-secret-must-not-leak" },
  "send_email",
  "model-call-1",
);
assert.equal(observer.pendingCount(), 1);
assert.equal(observer.events().length, 0);
assert.equal(getterReads, 0);
assert.equal(invokeCount, 0);

observer.handleToolEnd(
  { receipt: "output-secret-must-not-leak" },
  "run-1",
  "parent-1",
  ["secret-tag"],
);
assert.equal(observer.pendingCount(), 0);
assert.equal(observer.events().length, 1);
assert.equal(observer.events()[0].eventId, "langchain-tool-run:run-1");
assert.equal(observer.events()[0].canonicalName, "send_email");
assert.equal(observer.events()[0].status, "SUCCEEDED");
assert.equal(invokeCount, 0);
assert.equal(getterReads, 0);

const serializedSuccess = JSON.stringify(observer.events()[0]);
for (const secret of [
  "customer@example.com",
  "input-secret-must-not-leak",
  "metadata-secret-must-not-leak",
  "output-secret-must-not-leak",
  "secret-tag",
  "model-call-1",
]) {
  assert.equal(serializedSuccess.includes(secret), false, secret);
}
console.log("PASS - handleToolEnd emits secret-minimal SUCCEEDED evidence");

observer.handleToolStart(
  { name: "search_orders" },
  "private search query",
  "run-2",
  undefined,
  undefined,
  { authorization: "Bearer hidden" },
  "search_orders",
);
observer.handleToolError(
  new Error("provider-error-secret-must-not-leak"),
  "run-2",
);
assert.equal(observer.events().length, 2);
assert.equal(observer.events()[1].canonicalName, "search_orders");
assert.equal(observer.events()[1].status, "FAILED");
assert.equal(JSON.stringify(observer.events()[1]).includes("provider-error-secret"), false);
console.log("PASS - handleToolError emits FAILED without retaining error content");

// End/error without a matching start must not be guessed by run ID or tool name.
observer.handleToolEnd("orphan result", "orphan-run");
observer.handleToolError(new Error("orphan"), "orphan-error-run");
assert.equal(observer.events().length, 2);
console.log("PASS - orphan terminal callbacks fail closed");

// Unknown runName must not create a pending identity even when the serialized
// object contains a familiar-looking class id.
observer.handleToolStart(
  { id: ["langchain", "tools", "other"] },
  "input",
  "unknown-run",
  undefined,
  undefined,
  undefined,
  "delete_everything",
);
assert.equal(observer.pendingCount(), 0);
console.log("PASS - unknown/non-visible tool names are ignored");

const aggregate = aggregateToolExecutions(observer.events());
assert.equal(aggregate.acceptedEventCount, 2);
assert.equal(aggregate.summaries.length, 2);
for (const summary of aggregate.summaries) {
  const tool = visible.tools.find(item => item.toolId === summary.toolId);
  assert.ok(tool);
  const promoted = promoteToolExecution(tool, summary);
  assert.ok(promoted);
  assert.equal(promoted.evidence.level, "EXECUTED");
  assert.equal(promoted.visibility.executed, true);
}
assert.equal(invokeCount, 0);
console.log("PASS - exact LangChain Tool Graph entries promote to EXECUTED");

const drained = observer.drain();
assert.equal(drained.length, 2);
assert.equal(observer.events().length, 0);
assert.equal(invokeCount, 0);
console.log("PASS - callback observer never invokes LangChain tools");

console.log("langchain execution observer regression: PASS");

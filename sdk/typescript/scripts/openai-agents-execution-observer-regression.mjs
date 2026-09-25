import assert from "node:assert/strict";

import {
  aggregateToolExecutions,
  createOpenAIAgentsExecutionObserver,
  promoteToolExecution,
} from "../dist/discovery/index.js";

console.log("");
console.log("ONCE PHASE 11D OPENAI AGENTS EXECUTION OBSERVER REGRESSION");
console.log("=========================================================");

let invokeCount = 0;
const sendEmail = {
  type: "function",
  name: "send_email",
  description: "Send an external customer email",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string" },
    },
  },
  async invoke() {
    invokeCount += 1;
    throw new Error("observer must never invoke the tool");
  },
};

const webSearch = {
  type: "web_search",
  name: "web_search",
  description: "Search the web",
};

let toolsGetterReads = 0;
const agent = {
  name: "Support Agent",
  tools: [sendEmail, webSearch],
  mcpServers: [],
};
Object.defineProperty(agent, "secretClient", {
  enumerable: true,
  get() {
    toolsGetterReads += 1;
    throw new Error("observer must not inspect arbitrary agent fields");
  },
});

const observer = createOpenAIAgentsExecutionObserver(agent);
assert.equal(observer.snapshot.tools.length, 2);
assert.equal(invokeCount, 0);
assert.equal(toolsGetterReads, 0);

const context = {
  authorization: "Bearer context-secret-must-not-leak",
};
const startDetails = {
  toolCall: {
    type: "function_call",
    callId: "call-001",
    name: "send_email",
    arguments: JSON.stringify({
      to: "customer@example.com",
      api_key: "tool-argument-secret-must-not-leak",
    }),
    providerData: {
      token: "provider-secret-must-not-leak",
    },
  },
};

// Agent hook signature: (context, tool, { toolCall })
observer.onToolStart(context, sendEmail, startDetails);
assert.equal(observer.pendingCount(), 1);
assert.equal(observer.events().length, 0);
assert.equal(invokeCount, 0);

// Agent end signature: (context, tool, result, { toolCall })
observer.onToolEnd(
  context,
  sendEmail,
  { receipt: "result-secret-must-not-leak" },
  startDetails,
);
assert.equal(observer.pendingCount(), 0);
assert.equal(observer.events().length, 1);
const firstEvent = observer.events()[0];
assert.equal(firstEvent.eventId, "openai-tool-call:call-001");
assert.equal(firstEvent.canonicalName, "send_email");
assert.equal(firstEvent.status, "UNKNOWN");
assert.equal(firstEvent.source, "framework_callback");
assert.equal(typeof firstEvent.descriptorFingerprint, "string");
assert.equal(firstEvent.descriptorFingerprint.length, 64);
assert.equal(invokeCount, 0);

const firstSerialized = JSON.stringify(firstEvent);
for (const secret of [
  "context-secret-must-not-leak",
  "customer@example.com",
  "tool-argument-secret-must-not-leak",
  "provider-secret-must-not-leak",
  "result-secret-must-not-leak",
]) {
  assert.equal(firstSerialized.includes(secret), false, secret);
}
console.log("PASS - Agent hooks emit secret-minimal EXECUTED evidence metadata");

// Runner signature: (context, agent, tool, { toolCall }) and
// (context, agent, tool, result, { toolCall }).
const runnerDetailsA = {
  toolCall: {
    type: "function_call",
    callId: "call-002",
    name: "send_email",
    arguments: "{\"to\":\"a@example.com\"}",
  },
};
const runnerDetailsB = {
  toolCall: {
    type: "function_call",
    callId: "call-003",
    name: "send_email",
    arguments: "{\"to\":\"b@example.com\"}",
  },
};
observer.onToolStart(context, agent, sendEmail, runnerDetailsA);
observer.onToolStart(context, agent, sendEmail, runnerDetailsB);
assert.equal(observer.pendingCount(), 2);
observer.onToolEnd(context, agent, sendEmail, "result-b", runnerDetailsB);
observer.onToolEnd(context, agent, sendEmail, "result-a", runnerDetailsA);
assert.equal(observer.pendingCount(), 0);
assert.equal(observer.events().length, 3);
assert.deepEqual(
  observer.events().map(event => event.eventId),
  [
    "openai-tool-call:call-001",
    "openai-tool-call:call-003",
    "openai-tool-call:call-002",
  ],
);
assert.equal(invokeCount, 0);
console.log("PASS - Runner hooks correlate parallel same-tool calls by callId");

// Duplicate lifecycle delivery can happen when callers accidentally attach both
// Agent- and Runner-level listeners. Aggregation must dedupe by call ID.
observer.onToolEnd(context, agent, sendEmail, "duplicate-result", runnerDetailsA);
const aggregate = aggregateToolExecutions(observer.events());
assert.equal(aggregate.acceptedEventCount, 3);
assert.equal(aggregate.duplicateEventCount, 1);
assert.equal(aggregate.summaries.length, 1);
assert.equal(aggregate.summaries[0].callCount, 3);
console.log("PASS - duplicate lifecycle delivery does not inflate call counts");

const sendObservation = observer.snapshot.tools.find(
  tool => tool.canonicalName === "send_email",
);
assert.ok(sendObservation);
const promoted = promoteToolExecution(
  sendObservation,
  aggregate.summaries[0],
);
assert.ok(promoted);
assert.equal(promoted.evidence.level, "EXECUTED");
assert.equal(promoted.visibility.executed, true);
assert.equal(promoted.execution.callCount, 3);
assert.equal(invokeCount, 0);
console.log("PASS - observed lifecycle promotes the exact discovered tool");

// Unknown tools must remain invisible rather than being guessed by name.
const foreignTool = {
  type: "function",
  name: "send_email",
  description: "Same name, not registered on this agent",
};
observer.onToolStart(context, foreignTool, {
  toolCall: {
    callId: "foreign-1",
    name: "send_email",
    arguments: "{}",
  },
});
observer.onToolEnd(context, foreignTool, "foreign-result", {
  toolCall: {
    callId: "foreign-1",
    name: "send_email",
    arguments: "{}",
  },
});
assert.equal(observer.events().length, 4);
console.log("PASS - same-name foreign tool objects are not correlated");

const drained = observer.drain();
assert.equal(drained.length, 4);
assert.equal(observer.events().length, 0);
assert.equal(invokeCount, 0);
console.log("PASS - observer drains metadata without executing tools");

console.log("openai agents execution observer regression: PASS");

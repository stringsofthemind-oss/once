import assert from "node:assert/strict";

import {
  aggregateToolExecutions,
  discoverVercelAiSdkModelVisibleTools,
  observeVercelAiSdkStepExecutions,
  promoteToolExecution,
} from "../dist/discovery/index.js";

console.log("");
console.log("ONCE PHASE 11D VERCEL EXECUTION OBSERVER REGRESSION");
console.log("=================================================");

let executeCount = 0;
const request = {
  tools: {
    sendEmail: {
      description: "Send an external customer email",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
        },
      },
      async execute() {
        executeCount += 1;
        throw new Error("observer must never execute Vercel tools");
      },
    },
    webSearch: {
      description: "Search the web",
      inputSchema: { type: "object" },
    },
  },
  activeTools: ["sendEmail", "webSearch"],
};

const visible = discoverVercelAiSdkModelVisibleTools(
  request,
  "support-runtime",
);
assert.equal(visible.tools.length, 2);
assert.equal(executeCount, 0);

let getterReads = 0;
const step = {
  toolCalls: [
    {
      toolCallId: "call-1",
      toolName: "sendEmail",
      args: {
        to: "customer@example.com",
        token: "call-secret-must-not-leak",
      },
    },
    {
      toolCallId: "call-2",
      toolName: "webSearch",
      args: { query: "secret query" },
    },
    {
      toolCallId: "call-3",
      toolName: "sendEmail",
      args: { to: "never-executed@example.com" },
    },
  ],
  toolResults: [
    {
      toolCallId: "call-1",
      toolName: "sendEmail",
      result: { receipt: "result-secret-must-not-leak" },
      isError: false,
    },
    {
      toolCallId: "call-2",
      result: { error: "provider-secret-must-not-leak" },
      isError: true,
    },
  ],
};
Object.defineProperty(step, "providerMetadata", {
  enumerable: true,
  get() {
    getterReads += 1;
    throw new Error("observer must not evaluate unrelated step getters");
  },
});

const events = observeVercelAiSdkStepExecutions(step, visible);
assert.equal(events.length, 2);
assert.equal(executeCount, 0);
assert.equal(getterReads, 0);
assert.deepEqual(
  events.map(event => [event.eventId, event.canonicalName, event.status]),
  [
    ["vercel-tool-call:call-1", "sendEmail", "SUCCEEDED"],
    ["vercel-tool-call:call-2", "webSearch", "FAILED"],
  ],
);

const serialized = JSON.stringify(events);
for (const secret of [
  "customer@example.com",
  "call-secret-must-not-leak",
  "secret query",
  "result-secret-must-not-leak",
  "provider-secret-must-not-leak",
  "never-executed@example.com",
]) {
  assert.equal(serialized.includes(secret), false, secret);
}
console.log("PASS - only completed tool results become secret-minimal execution events");

// A tool call without a tool result must not be marked EXECUTED.
assert.equal(events.some(event => event.eventId === "vercel-tool-call:call-3"), false);
console.log("PASS - model tool calls without results are not execution evidence");

const aggregate = aggregateToolExecutions(events);
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
console.log("PASS - Vercel results promote exact model-visible tools to EXECUTED");

// Explicit isError is optional in some result shapes. Absence stays UNKNOWN.
const unknownEvents = observeVercelAiSdkStepExecutions(
  {
    toolCalls: [
      { toolCallId: "call-4", toolName: "sendEmail", args: {} },
    ],
    toolResults: [
      { toolCallId: "call-4", result: "opaque result" },
    ],
  },
  visible,
);
assert.equal(unknownEvents.length, 1);
assert.equal(unknownEvents[0].status, "UNKNOWN");
console.log("PASS - ambiguous Vercel result status remains UNKNOWN");

// Unknown or non-visible tool results fail closed instead of name guessing.
const foreign = observeVercelAiSdkStepExecutions(
  {
    toolCalls: [
      { toolCallId: "foreign-1", toolName: "deleteEverything", args: {} },
    ],
    toolResults: [
      { toolCallId: "foreign-1", toolName: "deleteEverything", result: "done" },
    ],
  },
  visible,
);
assert.deepEqual(foreign, []);
assert.equal(executeCount, 0);
console.log("PASS - non-visible tools are ignored rather than guessed");

console.log("vercel execution observer regression: PASS");

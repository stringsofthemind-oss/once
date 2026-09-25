import assert from "node:assert/strict";

import {
  aggregateToolExecutions,
  discoverOpenAIResponsesModelVisibleTools,
  observeOtelGenAiToolExecutions,
  promoteToolExecution,
} from "../dist/discovery/index.js";

console.log("");
console.log("ONCE PHASE 11D OTEL EXECUTION INGEST REGRESSION");
console.log("===============================================");

const visible = discoverOpenAIResponsesModelVisibleTools({
  tools: [
    {
      type: "function",
      name: "send_email",
      description: "Send an external customer email",
      parameters: { type: "object", properties: { to: { type: "string" } } },
    },
    {
      type: "function",
      name: "search_orders",
      description: "Search existing orders",
      parameters: { type: "object" },
    },
  ],
});

let dangerousGetterReads = 0;
const successAttributes = {
  "gen_ai.operation.name": "execute_tool",
  "gen_ai.tool.name": "send_email",
  "gen_ai.tool.call.id": "call-otel-1",
  "gen_ai.tool.call.arguments": JSON.stringify({
    to: "customer@example.com",
    api_key: "arguments-secret-must-not-leak",
  }),
  "gen_ai.tool.call.result": JSON.stringify({
    receipt: "result-secret-must-not-leak",
  }),
  "gen_ai.provider.name": "provider-secret-must-not-be-retained",
};
Object.defineProperty(successAttributes, "exception.message", {
  enumerable: true,
  get() {
    dangerousGetterReads += 1;
    throw new Error("OTel observer must never inspect exception content");
  },
});

const spans = [
  {
    traceId: "trace-1",
    spanId: "span-1",
    attributes: successAttributes,
    status: { code: 1 },
    endTime: "2026-09-25T12:30:00.000Z",
    durationMs: 17,
  },
  {
    traceId: "trace-1",
    spanId: "span-2",
    attributes: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search_orders",
      "gen_ai.tool.call.id": "call-otel-2",
      "error.type": "provider_failure_secret_value",
      "gen_ai.tool.call.arguments": "private query",
      "gen_ai.tool.call.result": "private result",
    },
    status: { code: 0 },
    endTime: "2026-09-25T12:30:01.000Z",
  },
  {
    traceId: "trace-1",
    spanId: "span-chat",
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.tool.name": "send_email",
    },
    status: { code: 1 },
  },
];

const events = observeOtelGenAiToolExecutions(spans, visible.tools);
assert.equal(events.length, 2);
assert.equal(dangerousGetterReads, 0);
assert.deepEqual(
  events.map(event => [event.eventId, event.canonicalName, event.status]),
  [
    ["otel-span:trace-1:span-1", "send_email", "SUCCEEDED"],
    ["otel-span:trace-1:span-2", "search_orders", "FAILED"],
  ],
);

const serialized = JSON.stringify(events);
for (const secret of [
  "customer@example.com",
  "arguments-secret-must-not-leak",
  "result-secret-must-not-leak",
  "provider-secret-must-not-be-retained",
  "provider_failure_secret_value",
  "private query",
  "private result",
]) {
  assert.equal(serialized.includes(secret), false, secret);
}
console.log("PASS - OTel ingestion reads only low-risk execute_tool metadata");

const aggregate = aggregateToolExecutions(events);
assert.equal(aggregate.summaries.length, 2);
for (const summary of aggregate.summaries) {
  const tool = visible.tools.find(item => item.toolId === summary.toolId);
  assert.ok(tool);
  const promoted = promoteToolExecution(tool, summary);
  assert.ok(promoted);
  assert.equal(promoted.evidence.level, "EXECUTED");
  assert.equal(promoted.visibility.executed, true);
}
console.log("PASS - OTel execution evidence promotes exact Tool Graph identities");

const callIdOnly = observeOtelGenAiToolExecutions(
  [
    {
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "send_email",
        "gen_ai.tool.call.id": "fallback-call",
      },
      status: { code: 0 },
    },
  ],
  visible.tools,
);
assert.equal(callIdOnly.length, 1);
assert.equal(callIdOnly[0].eventId, "otel-tool-call:fallback-call");
assert.equal(callIdOnly[0].status, "UNKNOWN");
console.log("PASS - call ID is a telemetry fallback, not an outcome claim");

// Generic OTel often identifies tools only by name. Duplicate candidates must
// fail closed rather than inheriting execution by order.
const duplicates = discoverOpenAIResponsesModelVisibleTools({
  tools: [
    {
      type: "function",
      name: "send_email",
      description: "External email",
      parameters: { type: "object" },
    },
    {
      type: "function",
      name: "send_email",
      description: "Internal email",
      parameters: {
        type: "object",
        properties: { internal: { type: "boolean" } },
      },
    },
  ],
});
const ambiguous = observeOtelGenAiToolExecutions(
  [
    {
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "send_email",
      },
      status: { code: 1 },
    },
  ],
  duplicates.tools,
);
assert.deepEqual(ambiguous, []);
console.log("PASS - ambiguous same-name OTel correlation fails closed");

let spanGetterReads = 0;
const hostileSpan = {
  attributes: {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "send_email",
  },
};
Object.defineProperty(hostileSpan, "resource", {
  enumerable: true,
  get() {
    spanGetterReads += 1;
    throw new Error("OTel observer must not inspect arbitrary span state");
  },
});
const hostileEvents = observeOtelGenAiToolExecutions([hostileSpan], visible.tools);
assert.equal(hostileEvents.length, 1);
assert.equal(spanGetterReads, 0);
console.log("PASS - unrelated span getters remain inert");

console.log("otel execution observer regression: PASS");

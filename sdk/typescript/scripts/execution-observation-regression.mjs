import assert from "node:assert/strict";

import {
  aggregateToolExecutions,
  discoverOpenAIResponsesModelVisibleTools,
  observeToolExecution,
  promoteToolExecution,
} from "../dist/discovery/index.js";

console.log("");
console.log("ONCE PHASE 11D EXECUTION OBSERVATION REGRESSION");
console.log("==============================================");

let getterReads = 0;
const hostileEvent = {
  eventId: "evt-1",
  toolId: "tool-123",
  namespacedName: "openai-responses/model/send_email",
  canonicalName: "send_email",
  framework: "openai-responses",
  runtimeName: "model",
  source: "framework_callback",
  status: "SUCCEEDED",
  observedAt: "2026-09-25T12:00:00.000Z",
  durationMs: 42,
  arguments: {
    to: "customer@example.com",
    api_key: "argument-secret-must-not-leak",
  },
  result: {
    receipt: "provider-result-must-not-leak",
  },
  authorization: "Bearer auth-secret-must-not-leak",
  error: "exception-text-must-not-leak",
};
Object.defineProperty(hostileEvent, "client", {
  enumerable: true,
  get() {
    getterReads += 1;
    throw new Error("execution observation must not evaluate getters");
  },
});

const observed = observeToolExecution(hostileEvent);
assert.equal(observed.accepted, true);
assert.equal(getterReads, 0);
assert.deepEqual(observed.event, {
  eventId: "evt-1",
  toolId: "tool-123",
  namespacedName: "openai-responses/model/send_email",
  canonicalName: "send_email",
  framework: "openai-responses",
  runtimeName: "model",
  source: "framework_callback",
  status: "SUCCEEDED",
  observedAt: "2026-09-25T12:00:00.000Z",
  durationMs: 42,
});
const serialized = JSON.stringify(observed);
for (const secret of [
  "argument-secret-must-not-leak",
  "provider-result-must-not-leak",
  "auth-secret-must-not-leak",
  "exception-text-must-not-leak",
  "customer@example.com",
]) {
  assert.equal(serialized.includes(secret), false, secret);
}
console.log("PASS - execution events retain only whitelisted metadata");

assert.deepEqual(
  observeToolExecution({
    canonicalName: "send_email",
    source: "adapter",
    status: "SUCCEEDED",
  }),
  { accepted: false, reason: "IDENTITY_REQUIRED" },
);
assert.deepEqual(
  observeToolExecution({
    toolId: "tool-1",
    source: "adapter",
    status: "STARTED",
  }),
  { accepted: false, reason: "INVALID_STATUS" },
);
console.log("PASS - ambiguous or invalid events fail closed");

const aggregate = aggregateToolExecutions([
  {
    eventId: "evt-1",
    toolId: "tool-123",
    namespacedName: "openai-responses/model/send_email",
    canonicalName: "send_email",
    source: "framework_callback",
    status: "SUCCEEDED",
    observedAt: "2026-09-25T12:00:00.000Z",
    durationMs: 42,
  },
  {
    eventId: "evt-1",
    toolId: "tool-123",
    namespacedName: "openai-responses/model/send_email",
    canonicalName: "send_email",
    source: "otel",
    status: "SUCCEEDED",
    observedAt: "2026-09-25T12:00:00.100Z",
    durationMs: 43,
  },
  {
    eventId: "evt-2",
    toolId: "tool-123",
    namespacedName: "openai-responses/model/send_email",
    canonicalName: "send_email",
    source: "otel",
    status: "FAILED",
    observedAt: "2026-09-25T12:01:00.000Z",
    durationMs: 18,
  },
  {
    namespacedName: "openai-responses/model/web_search",
    canonicalName: "web_search",
    source: "adapter",
    status: "UNKNOWN",
    observedAt: "2026-09-25T12:02:00.000Z",
  },
  {
    canonicalName: "missing_identity",
    source: "adapter",
    status: "SUCCEEDED",
  },
]);

assert.equal(aggregate.acceptedEventCount, 3);
assert.equal(aggregate.duplicateEventCount, 1);
assert.equal(aggregate.rejectedEventCount, 1);
assert.equal(aggregate.summaries.length, 2);
const sendSummary = aggregate.summaries.find(
  summary => summary.toolId === "tool-123",
);
assert.ok(sendSummary);
assert.equal(sendSummary.callCount, 2);
assert.equal(sendSummary.succeededCount, 1);
assert.equal(sendSummary.failedCount, 1);
assert.equal(sendSummary.latestStatus, "FAILED");
assert.equal(sendSummary.totalDurationMs, 60);
assert.equal(sendSummary.averageDurationMs, 30);
assert.deepEqual(sendSummary.sources, ["framework_callback", "otel"]);
console.log("PASS - aggregation deduplicates telemetry and records outcomes");

const visible = discoverOpenAIResponsesModelVisibleTools({
  tools: [
    {
      type: "function",
      name: "send_email",
      description: "Send an external customer email",
      parameters: { type: "object" },
    },
    {
      type: "function",
      name: "send_email",
      description: "Send an internal email from another namespace",
      parameters: { type: "object", properties: { internal: { type: "boolean" } } },
    },
  ],
});

const target = visible.tools[0];
const neighbor = visible.tools[1];
assert.ok(target);
assert.ok(neighbor);
assert.equal(target.evidence.level, "MODEL_VISIBLE");
assert.equal(target.visibility.executed, false);

const targetAggregate = aggregateToolExecutions([
  {
    eventId: "evt-target",
    toolId: target.toolId,
    namespacedName: target.namespacedName,
    canonicalName: target.canonicalName,
    source: "framework_callback",
    status: "SUCCEEDED",
    observedAt: "2026-09-25T12:03:00.000Z",
    durationMs: 25,
  },
]);
const targetSummary = targetAggregate.summaries[0];
assert.ok(targetSummary);

const promoted = promoteToolExecution(target, targetSummary);
assert.ok(promoted);
assert.equal(promoted.evidence.level, "EXECUTED");
assert.equal(promoted.visibility.executed, true);
assert.equal(promoted.execution.callCount, 1);
assert.equal(
  promoted.once.actionPriority.score >= target.once.actionPriority.score,
  true,
);
assert.equal(promoteToolExecution(neighbor, targetSummary), undefined);
console.log("PASS - exact identity promotes only the executed Tool Graph entry");

const nameOnlyAggregate = aggregateToolExecutions([
  {
    namespacedName: target.namespacedName,
    canonicalName: target.canonicalName,
    source: "adapter",
    status: "SUCCEEDED",
    observedAt: "2026-09-25T12:04:00.000Z",
  },
]);
assert.ok(promoteToolExecution(target, nameOnlyAggregate.summaries[0]));
assert.equal(
  promoteToolExecution(
    { ...target, namespacedName: "different/runtime/send_email" },
    nameOnlyAggregate.summaries[0],
  ),
  undefined,
);
console.log("PASS - namespaced correlation is accepted, bare names are not");

console.log("execution observation regression: PASS");

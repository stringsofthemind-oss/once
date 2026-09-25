import assert from "node:assert/strict";

import {
  aggregateToolExecutions,
  discoverVercelAiSdkModelVisibleTools,
  discoverVercelAiSdkRegisteredTools,
  mergeRuntimeToolEvidence,
  observeOtelGenAiToolExecutions,
  promoteToolExecution,
} from "../dist/discovery/index.js";

console.log("");
console.log("ONCE PHASE 11D END-TO-END EVIDENCE LADDER");
console.log("=========================================");

let executeCount = 0;
const toolSet = {
  send_email: {
    description: "Send an external customer email",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
      },
    },
    async execute() {
      executeCount += 1;
      throw new Error("evidence regression must not execute tools");
    },
  },
};

const registered = discoverVercelAiSdkRegisteredTools(
  toolSet,
  "release-proof-runtime",
);
assert.equal(registered.tools.length, 1);
assert.equal(registered.tools[0].evidence.level, "RUNTIME_REGISTERED");
assert.equal(registered.tools[0].visibility.executed, false);
assert.equal(executeCount, 0);
console.log("PASS - runtime registration evidence established without execution");

const visible = discoverVercelAiSdkModelVisibleTools(
  {
    tools: toolSet,
    activeTools: ["send_email"],
  },
  "release-proof-runtime",
);
assert.equal(visible.tools.length, 1);
assert.equal(visible.tools[0].evidence.level, "MODEL_VISIBLE");
assert.equal(visible.tools[0].visibility.modelVisible, true);
assert.equal(visible.tools[0].visibility.executed, false);
assert.equal(executeCount, 0);
console.log("PASS - model-visible evidence established without execution");

const merged = mergeRuntimeToolEvidence(registered, visible);
assert.equal(merged.tools.length, 1);
const modelVisibleTool = merged.tools[0];
assert.equal(modelVisibleTool.evidence.level, "MODEL_VISIBLE");
assert.equal(modelVisibleTool.visibility.runtimeRegistered, true);
assert.equal(modelVisibleTool.visibility.modelVisible, true);
assert.equal(modelVisibleTool.visibility.executed, false);
const priorityBeforeExecution = modelVisibleTool.once.actionPriority.score;
console.log("PASS - evidence merger preserves the stronger model-visible state");

const executionEvents = observeOtelGenAiToolExecutions(
  [
    {
      traceId: "release-proof-trace",
      spanId: "release-proof-tool-span",
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "send_email",
        "gen_ai.tool.call.id": "release-proof-call",
        "gen_ai.tool.call.arguments": JSON.stringify({
          to: "private@example.com",
          token: "must-not-survive",
        }),
        "gen_ai.tool.call.result": JSON.stringify({
          receipt: "must-not-survive",
        }),
      },
      status: { code: 1 },
      endTime: "2026-09-25T12:40:00.000Z",
      durationMs: 31,
    },
  ],
  merged.tools,
);
assert.equal(executionEvents.length, 1);
assert.equal(executionEvents[0].status, "SUCCEEDED");
assert.equal(JSON.stringify(executionEvents).includes("private@example.com"), false);
assert.equal(JSON.stringify(executionEvents).includes("must-not-survive"), false);
assert.equal(executeCount, 0);
console.log("PASS - real execution telemetry creates secret-minimal execution evidence");

const aggregate = aggregateToolExecutions(executionEvents);
assert.equal(aggregate.acceptedEventCount, 1);
assert.equal(aggregate.summaries.length, 1);
assert.equal(aggregate.summaries[0].callCount, 1);
assert.equal(aggregate.summaries[0].succeededCount, 1);

const executed = promoteToolExecution(
  modelVisibleTool,
  aggregate.summaries[0],
);
assert.ok(executed);
assert.equal(executed.evidence.level, "EXECUTED");
assert.equal(executed.visibility.runtimeRegistered, true);
assert.equal(executed.visibility.modelVisible, true);
assert.equal(executed.visibility.executed, true);
assert.equal(executed.execution.callCount, 1);
assert.equal(
  executed.once.actionPriority.score >= priorityBeforeExecution,
  true,
);
assert.equal(executeCount, 0);
console.log("PASS - exact tool is promoted to EXECUTED and priority is recomputed");

console.log("evidence ladder: RUNTIME_REGISTERED -> MODEL_VISIBLE -> EXECUTED");
console.log("phase11d evidence ladder regression: PASS");

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  connectOpenAIAgentsFunctionToolsGatewayAuto,
} from "../../dist/gateway/index.js";

test("OpenAI Gateway ignores transport call ID for protected logical retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "once-openai-gateway-"));
  const statePath = path.join(directory, "operations.sqlite");

  let effects = 0;
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
    async invoke(runContext, rawInput, details) {
      effects += 1;
      const parsed = JSON.parse(rawInput);
      return {
        receipt: `${parsed.to}:${parsed.body}`,
        contextId: runContext.contextId,
        transportCallId: details.toolCall.callId,
      };
    },
  };

  try {
    const gateway = connectOpenAIAgentsFunctionToolsGatewayAuto(
      [sendTool],
      { statePath },
    );

    assert.equal(gateway.plan.entries[0].route, "PROTECT");

    const args = {
      idempotencyKey: "intent-openai-email-001",
      to: "customer@example.test",
      body: "hello",
    };
    const raw = JSON.stringify(args);

    const first = await gateway.tools[0].invoke(
      { contextId: "ctx-a" },
      raw,
      { toolCall: { callId: "transport-call-first" } },
    );
    const retry = await gateway.tools[0].invoke(
      { contextId: "ctx-b" },
      raw,
      { toolCall: { callId: "transport-call-retry" } },
    );

    assert.equal(effects, 1);
    assert.deepEqual(retry, first);
    assert.equal(first.transportCallId, "transport-call-first");
    assert.equal(first.contextId, "ctx-a");

    await assert.rejects(
      gateway.tools[0].invoke(
        { contextId: "ctx-c" },
        JSON.stringify({ ...args, body: "changed" }),
        { toolCall: { callId: "transport-call-third" } },
      ),
      error => error?.code === "CONFLICT",
    );
    assert.equal(effects, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

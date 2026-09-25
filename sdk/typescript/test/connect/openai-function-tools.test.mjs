import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AgentToolConnectionError,
  OpenAIAgentsConnectError,
  connectOpenAIAgentsFunctionToolsAuto,
} from "@once-agent/sdk/connect";

const [major, minor] = process.versions.node.split(".").map(Number);
const localReady = major > 24 || (major === 24 && minor >= 15);

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "once-openai-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    statePath: path.join(dir, "state.sqlite"),
    effectsPath: path.join(dir, "effects.json"),
  };
}

function appendEffect(file, value) {
  let rows = [];
  try {
    rows = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // First effect.
  }
  rows.push(value);
  writeFileSync(file, JSON.stringify(rows));
}

function countEffects(file) {
  return JSON.parse(readFileSync(file, "utf8")).length;
}

function functionTool({
  name,
  description,
  invoke,
  providerData = { vendor: "test" },
}) {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    strict: true,
    providerData,
    needsApproval: () => false,
    isEnabled: () => true,
    invoke,
  };
}

test("wraps a bypass FunctionTool without changing its framework invocation contract", async () => {
  const calls = [];
  const providerData = { vendor: "openai-test" };
  const original = functionTool({
    name: "search_web",
    description: "Search the public web.",
    providerData,
    async invoke(runContext, input, details) {
      calls.push({ runContext, input, details });
      return `search:${input}`;
    },
  });
  const originals = [original];

  const connected = connectOpenAIAgentsFunctionToolsAuto(originals);

  assert.deepEqual(connected.plan.summary, {
    total: 1,
    protect: 0,
    bypass: 1,
    unknown: 0,
  });
  assert.equal(Object.isFrozen(connected), true);
  assert.equal(Object.isFrozen(connected.tools), true);
  assert.equal(Object.isFrozen(originals), false);
  assert.equal(connected.tools.length, 1);
  assert.notEqual(connected.tools[0], original);
  assert.equal(connected.tools[0].providerData, providerData);
  assert.equal(connected.tools[0].strict, true);
  assert.equal(connected.tools[0].parameters, original.parameters);
  assert.equal(original.invoke === connected.tools[0].invoke, false);

  const runContext = { run: "ctx" };
  const details = { toolCallId: "call-search-1" };
  const rawInput = '{"query":"once"}';

  assert.equal(
    await connected.tools[0].invoke(runContext, rawInput, details),
    `search:${rawInput}`,
  );
  assert.deepEqual(calls, [{ runContext, input: rawInput, details }]);
});

test("rejects non-FunctionTool entries instead of returning partial protection", () => {
  assert.throws(
    () => connectOpenAIAgentsFunctionToolsAuto([
      functionTool({
        name: "search_web",
        description: "Search the public web.",
        async invoke() { return "ok"; },
      }),
      {
        type: "hosted_tool",
        name: "computer",
      },
    ]),
    error =>
      error instanceof OpenAIAgentsConnectError &&
      error.code === "UNSUPPORTED_OPENAI_TOOL_TYPE",
  );
});

test("UNKNOWN FunctionTool safety fails closed unless explicitly clarified", async () => {
  const ambiguous = functionTool({
    name: "frobnicate_account",
    description: "Perform the frobnication operation.",
    async invoke() { return "ok"; },
  });

  assert.throws(
    () => connectOpenAIAgentsFunctionToolsAuto([ambiguous]),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "UNKNOWN_TOOLSET_SAFETY",
  );

  const connected = connectOpenAIAgentsFunctionToolsAuto(
    [ambiguous],
    {
      overrides: {
        frobnicate_account: {
          annotations: { readOnlyHint: true },
        },
      },
    },
  );

  assert.equal(connected.plan.summary.bypass, 1);
  assert.equal(
    await connected.tools[0].invoke({}, "{}", { toolCallId: "call-1" }),
    "ok",
  );
});

test("protected FunctionTool rejects malformed JSON before original invoke", async () => {
  let calls = 0;
  const connected = connectOpenAIAgentsFunctionToolsAuto([
    functionTool({
      name: "send_email",
      description: "Send an email to a recipient.",
      async invoke() {
        calls += 1;
        return "sent";
      },
    }),
  ]);

  await assert.rejects(
    connected.tools[0].invoke({}, "not-json", { toolCallId: "call-1" }),
    error =>
      error instanceof OpenAIAgentsConnectError &&
      error.code === "INVALID_OPENAI_TOOL_INPUT",
  );
  assert.equal(calls, 0);
});

test("unknown override name is rejected rather than ignored", () => {
  assert.throws(
    () => connectOpenAIAgentsFunctionToolsAuto([
      functionTool({
        name: "search_web",
        description: "Search the public web.",
        async invoke() { return "ok"; },
      }),
    ], {
      overrides: {
        send_email: {
          annotations: { readOnlyHint: false },
        },
      },
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "UNDECLARED_TOOL_OVERRIDE",
  );
});

test("duplicate FunctionTool names are rejected", () => {
  const tool = () => functionTool({
    name: "search_web",
    description: "Search the public web.",
    async invoke() { return "ok"; },
  });

  assert.throws(
    () => connectOpenAIAgentsFunctionToolsAuto([tool(), tool()]),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "DUPLICATE_TOOL_NAME",
  );
});

test("Once metadata can make a callback-free protected FunctionTool contract explicit", () => {
  const connected = connectOpenAIAgentsFunctionToolsAuto([
    functionTool({
      name: "send_email",
      description: "Send an email to a recipient.",
      async invoke() { return "sent"; },
    }),
  ], {
    overrides: {
      send_email: {
        _meta: {
          once: {
            identityFields: ["intent"],
            effectFields: ["destination", "body"],
          },
        },
      },
    },
  });

  assert.equal(connected.plan.summary.protect, 1);
  assert.equal(connected.plan.ready, true);
});

test("changing OpenAI tool-call details does not create a second protected effect", { skip: !localReady }, async (t) => {
  const f = fixture(t);
  const seen = [];
  const connected = connectOpenAIAgentsFunctionToolsAuto([
    functionTool({
      name: "send_email",
      description: "Send an email to a recipient.",
      async invoke(runContext, rawInput, details) {
        const input = JSON.parse(rawInput);
        seen.push({ runContext, details });
        appendEffect(f.effectsPath, {
          destination: input.destination,
          body: input.body,
        });
        return `mail-${countEffects(f.effectsPath)}`;
      },
    }),
  ], {
    statePath: f.statePath,
    overrides: {
      send_email: {
        _meta: {
          once: {
            effectFields: ["destination", "body"],
          },
        },
      },
    },
  });

  const rawInput = JSON.stringify({
    idempotencyKey: "invoice-42",
    destination: "test@example.invalid",
    body: "Invoice 42",
  });

  assert.equal(
    await connected.tools[0].invoke(
      { run: 1 },
      rawInput,
      { toolCallId: "call-A" },
    ),
    "mail-1",
  );

  assert.equal(
    await connected.tools[0].invoke(
      { run: 2 },
      rawInput,
      { toolCallId: "call-B" },
    ),
    "mail-1",
  );

  assert.equal(countEffects(f.effectsPath), 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    runContext: { run: 1 },
    details: { toolCallId: "call-A" },
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECT_MANIFEST_VERSION,
  CONNECT_TOOL_DECISION,
  planConnectToolManifest,
} from "@once-agent/sdk/connect";

test("plans an MCP-style tools/list result in manifest order", () => {
  const plan = planConnectToolManifest({
    tools: [
      {
        name: "search_web",
        description: "Search the public web.",
        annotations: { readOnlyHint: true },
      },
      {
        name: "send_email",
        description: "Send an email to a recipient.",
      },
      {
        name: "frobnicate_account",
      },
    ],
  });

  assert.equal(plan.version, CONNECT_MANIFEST_VERSION);
  assert.equal(plan.valid, true);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.summary, {
    total: 3,
    protect: 1,
    bypass: 1,
    unknown: 1,
  });

  assert.deepEqual(
    plan.entries.map(entry => [entry.index, entry.name, entry.decision]),
    [
      [0, "search_web", CONNECT_TOOL_DECISION.BYPASS],
      [1, "send_email", CONNECT_TOOL_DECISION.PROTECT],
      [2, "frobnicate_account", CONNECT_TOOL_DECISION.UNKNOWN],
    ],
  );
});

test("plans OpenAI-style function tools", () => {
  const plan = planConnectToolManifest([
    {
      type: "function",
      function: {
        name: "search_web",
        description: "Search the public web.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "charge_customer",
        description: "Charge a customer for an order.",
        parameters: {
          type: "object",
          properties: {
            customer_id: { type: "string" },
          },
        },
      },
    },
  ]);

  assert.equal(plan.valid, true);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.summary, {
    total: 2,
    protect: 1,
    bypass: 1,
    unknown: 0,
  });

  assert.equal(plan.entries[0].source, "openai_function");
  assert.equal(plan.entries[1].source, "openai_function");
});

test("native and OpenAI entries may coexist in one manifest", () => {
  const plan = planConnectToolManifest([
    { name: "get_customer" },
    {
      type: "function",
      function: {
        name: "delete_customer",
      },
    },
  ]);

  assert.equal(plan.ready, true);
  assert.equal(plan.entries[0].source, "native");
  assert.equal(plan.entries[1].source, "openai_function");
  assert.equal(plan.entries[0].decision, CONNECT_TOOL_DECISION.BYPASS);
  assert.equal(plan.entries[1].decision, CONNECT_TOOL_DECISION.PROTECT);
});

test("UNKNOWN prevents a manifest from being ready for automatic routing", () => {
  const plan = planConnectToolManifest([
    { name: "search_web" },
    { name: "mystery_account_operation" },
  ]);

  assert.equal(plan.valid, true);
  assert.equal(plan.ready, false);
  assert.equal(plan.unknown.length, 1);
  assert.equal(plan.unknown[0].name, "mystery_account_operation");
});

test("invalid entries become UNKNOWN rather than disappearing", () => {
  const plan = planConnectToolManifest([
    { name: "search_web" },
    null,
    { type: "function", function: { description: "Missing name" } },
  ]);

  assert.equal(plan.summary.total, 3);
  assert.equal(plan.summary.bypass, 1);
  assert.equal(plan.summary.unknown, 2);
  assert.equal(plan.entries[1].source, "invalid");
  assert.equal(plan.entries[2].source, "invalid");
  assert.equal(plan.ready, false);
});

test("invalid manifest shape fails closed", () => {
  for (const manifest of [null, {}, { tools: null }, "tools"]) {
    const plan = planConnectToolManifest(manifest);

    assert.equal(plan.valid, false);
    assert.equal(plan.ready, false);
    assert.equal(plan.reason, "INVALID_MANIFEST");
    assert.deepEqual(plan.summary, {
      total: 0,
      protect: 0,
      bypass: 0,
      unknown: 0,
    });
  }
});

test("empty valid manifest is ready and has zero decisions", () => {
  const plan = planConnectToolManifest([]);

  assert.equal(plan.valid, true);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.summary, {
    total: 0,
    protect: 0,
    bypass: 0,
    unknown: 0,
  });
});

test("duplicate tool names remain distinct ordered entries", () => {
  const plan = planConnectToolManifest([
    { name: "send_email" },
    { name: "send_email" },
  ]);

  assert.equal(plan.entries.length, 2);
  assert.equal(plan.entries[0].index, 0);
  assert.equal(plan.entries[1].index, 1);
  assert.equal(plan.summary.protect, 2);
});

test("plan partitions reference the same classified decisions", () => {
  const plan = planConnectToolManifest([
    { name: "search_web" },
    { name: "send_email" },
    { name: "mystery" },
  ]);

  assert.deepEqual(plan.bypass.map(entry => entry.name), ["search_web"]);
  assert.deepEqual(plan.protect.map(entry => entry.name), ["send_email"]);
  assert.deepEqual(plan.unknown.map(entry => entry.name), ["mystery"]);
});

test("returned planning structures are frozen", () => {
  const plan = planConnectToolManifest([
    { name: "search_web" },
  ]);

  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.entries), true);
  assert.equal(Object.isFrozen(plan.entries[0]), true);
  assert.equal(Object.isFrozen(plan.entries[0].signals), true);
  assert.equal(Object.isFrozen(plan.summary), true);
});

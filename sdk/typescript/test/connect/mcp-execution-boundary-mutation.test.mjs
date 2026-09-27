import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONNECT_TOOL_DECISION,
  McpExecutionBoundaryError,
  createMcpExecutionBoundary,
} from "@once-agent/sdk/connect";

const [major, minor] = process.versions.node.split(".").map(Number);
const localReady = major > 24 || (major === 24 && minor >= 15);

function stateFixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "once-mcp-boundary-mutation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "state.sqlite");
}

test("authoritative MCP catalog is snapshotted and listTools cannot mutate routing state", async () => {
  const tools = [{
    name: "create_order",
    description: "Create an external order.",
    annotations: {
      idempotentHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        operation_id: { type: "string" },
      },
    },
  }];

  const boundary = createMcpExecutionBoundary({
    serverId: "snapshot-server",
    tools,
    upstream: {
      async callTool() {
        return { ok: true };
      },
    },
  });

  assert.equal(boundary.plan.protect.length, 1);
  assert.equal(boundary.plan.bypass.length, 0);

  tools[0].name = "search_orders";
  tools[0].description = "Read-only search.";
  tools[0].annotations.idempotentHint = false;

  const firstListing = boundary.listTools();
  assert.equal(firstListing.tools[0].name, "create_order");
  assert.equal(firstListing.tools[0].description, "Create an external order.");

  firstListing.tools[0].name = "search_orders";
  firstListing.tools[0].annotations.idempotentHint = false;

  const secondListing = boundary.listTools();
  assert.equal(secondListing.tools[0].name, "create_order");
  assert.equal(secondListing.tools[0].annotations.idempotentHint, true);
  assert.equal(boundary.plan.protect.length, 1);
});

test("reviewed local override is snapshotted and later mutation cannot downgrade PROTECT", { skip: !localReady }, async (t) => {
  let upstreamCalls = 0;
  const override = {
    decision: CONNECT_TOOL_DECISION.PROTECT,
  };

  const boundary = createMcpExecutionBoundary({
    serverId: "override-snapshot-server",
    tools: [{
      name: "account_operation",
      description: "Perform an account operation.",
    }],
    statePath: stateFixture(t),
    overrides: {
      account_operation: override,
    },
    upstream: {
      async callTool() {
        upstreamCalls += 1;
        return { ok: true };
      },
    },
  });

  assert.equal(boundary.plan.protect.length, 1);

  override.decision = CONNECT_TOOL_DECISION.BYPASS;

  await assert.rejects(
    boundary.callTool({
      name: "account_operation",
      arguments: {
        account: "acct-1",
      },
    }),
    error =>
      error instanceof McpExecutionBoundaryError &&
      error.code === "IDENTITY_REQUIRED",
  );

  assert.equal(upstreamCalls, 0);
  assert.equal(boundary.plan.protect.length, 1);
  assert.equal(boundary.plan.bypass.length, 0);
});

test("reviewed identity field arrays are copied before later caller mutation", { skip: !localReady }, async (t) => {
  let upstreamCalls = 0;
  const identityFields = ["order"];
  const effectFields = ["order", "amount"];

  const boundary = createMcpExecutionBoundary({
    serverId: "field-snapshot-server",
    tools: [{
      name: "create_order",
      description: "Create an external order.",
    }],
    statePath: stateFixture(t),
    overrides: {
      create_order: {
        identityFields,
        effectFields,
      },
    },
    upstream: {
      async callTool() {
        upstreamCalls += 1;
        return { receipt: `receipt-${upstreamCalls}` };
      },
    },
  });

  identityFields[0] = "attempt";
  effectFields[0] = "attempt";

  const first = await boundary.callTool({
    name: "create_order",
    arguments: {
      order: "order-42",
      amount: 100,
      attempt: "a",
    },
  });
  const retry = await boundary.callTool({
    name: "create_order",
    arguments: {
      order: "order-42",
      amount: 100,
      attempt: "b",
    },
  });

  assert.deepEqual(retry, first);
  assert.equal(upstreamCalls, 1);
});

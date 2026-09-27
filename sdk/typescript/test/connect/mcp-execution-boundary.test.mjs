import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalProtectionError,
} from "@once-agent/sdk";

import {
  CONNECT_TOOL_DECISION,
  McpExecutionBoundaryError,
  classifyRemoteMcpTool,
  createMcpExecutionBoundary,
} from "@once-agent/sdk/connect";

const [major, minor] = process.versions.node.split(".").map(Number);
const localReady = major > 24 || (major === 24 && minor >= 15);

function stateFixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "once-mcp-boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "state.sqlite");
}

function upstream(handler) {
  const calls = [];
  return {
    calls,
    client: {
      async callTool(request) {
        calls.push(request);
        return handler(request, calls.length);
      },
    },
  };
}

test("remote MCP annotations can escalate protection but cannot grant a bypass", () => {
  assert.equal(
    classifyRemoteMcpTool({
      name: "create_refund",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    }).decision,
    CONNECT_TOOL_DECISION.PROTECT,
  );

  assert.equal(
    classifyRemoteMcpTool({
      name: "frobnicate_account",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    }).decision,
    CONNECT_TOOL_DECISION.UNKNOWN,
  );

  assert.equal(
    classifyRemoteMcpTool({
      name: "account_operation",
      annotations: {
        destructiveHint: true,
      },
    }).decision,
    CONNECT_TOOL_DECISION.PROTECT,
  );
});

test("a reviewed local override is authoritative for unresolved remote semantics", () => {
  const classified = classifyRemoteMcpTool(
    { name: "frobnicate_account" },
    { decision: CONNECT_TOOL_DECISION.BYPASS },
  );

  assert.equal(classified.decision, CONNECT_TOOL_DECISION.BYPASS);
  assert.equal(classified.source, "local_override");
});

test("read-only MCP tools bypass durable execution protection", async () => {
  const u = upstream(async (request, count) => ({
    query: request.arguments.query,
    count,
  }));

  const boundary = createMcpExecutionBoundary({
    serverId: "search-server",
    tools: [{
      name: "search_web",
      description: "Search the public web without modifying external state.",
    }],
    upstream: u.client,
  });

  assert.equal(boundary.plan.ready, true);
  assert.equal(boundary.plan.bypass.length, 1);

  assert.deepEqual(
    await boundary.callTool({
      name: "search_web",
      arguments: { query: "once" },
      requestId: "rpc-1",
    }),
    { query: "once", count: 1 },
  );

  assert.deepEqual(
    await boundary.callTool({
      name: "search_web",
      arguments: { query: "once" },
      requestId: "rpc-2",
    }),
    { query: "once", count: 2 },
  );

  assert.equal(u.calls.length, 2);
});

test("UNKNOWN MCP tools fail closed before the upstream server", async () => {
  const u = upstream(async () => ({ ok: true }));
  const boundary = createMcpExecutionBoundary({
    serverId: "unknown-server",
    tools: [{
      name: "frobnicate_account",
      annotations: { idempotentHint: true },
    }],
    upstream: u.client,
  });

  assert.equal(boundary.plan.ready, false);
  assert.equal(boundary.plan.unknown.length, 1);

  await assert.rejects(
    boundary.callTool({
      name: "frobnicate_account",
      arguments: { account: "acct-1" },
      requestId: "rpc-1",
    }),
    error =>
      error instanceof McpExecutionBoundaryError &&
      error.code === "UNKNOWN_TOOL_SAFETY",
  );

  assert.equal(u.calls.length, 0);
});

test("protected MCP retry ignores changing JSON-RPC request ids and replays one effect", { skip: !localReady }, async (t) => {
  const u = upstream(async (request, count) => ({
    refundId: `refund-${count}`,
    amount: request.arguments.amount,
  }));

  const boundary = createMcpExecutionBoundary({
    serverId: "stripe-mcp",
    tools: [{
      name: "create_refund",
      description: "Create a refund for a payment.",
      annotations: { idempotentHint: true },
    }],
    upstream: u.client,
    statePath: stateFixture(t),
  });

  const first = await boundary.callTool({
    name: "create_refund",
    arguments: {
      operation_id: "refund-order-42",
      payment: "pi_42",
      amount: 4999,
    },
    requestId: "rpc-first",
  });

  const retry = await boundary.callTool({
    name: "create_refund",
    arguments: {
      operation_id: "refund-order-42",
      payment: "pi_42",
      amount: 4999,
    },
    requestId: "rpc-retry-with-different-id",
  });

  assert.deepEqual(first, { refundId: "refund-1", amount: 4999 });
  assert.deepEqual(retry, first);
  assert.equal(u.calls.length, 1);
  assert.equal(u.calls[0].requestId, "rpc-first");
});

test("same protected logical operation with a changed effect is CONFLICT", { skip: !localReady }, async (t) => {
  const u = upstream(async (_request, count) => ({ receipt: `effect-${count}` }));
  const boundary = createMcpExecutionBoundary({
    serverId: "payments-mcp",
    tools: [{
      name: "send_payment",
      description: "Send a payment to a recipient.",
    }],
    upstream: u.client,
    statePath: stateFixture(t),
  });

  await boundary.callTool({
    name: "send_payment",
    arguments: {
      intent_id: "invoice-42",
      recipient: "acct-a",
      amount: 1000,
    },
    requestId: 1,
  });

  await assert.rejects(
    boundary.callTool({
      name: "send_payment",
      arguments: {
        intent_id: "invoice-42",
        recipient: "acct-a",
        amount: 2000,
      },
      requestId: 2,
    }),
    error => error instanceof LocalProtectionError && error.code === "CONFLICT",
  );

  assert.equal(u.calls.length, 1);
});

test("protected MCP call with no trustworthy stable identity never dispatches", { skip: !localReady }, async (t) => {
  const u = upstream(async () => ({ ok: true }));
  const boundary = createMcpExecutionBoundary({
    serverId: "payments-mcp",
    tools: [{
      name: "send_payment",
      description: "Send a payment to a recipient.",
    }],
    upstream: u.client,
    statePath: stateFixture(t),
  });

  await assert.rejects(
    boundary.callTool({
      name: "send_payment",
      arguments: {
        recipient: "acct-a",
        amount: 1000,
      },
      requestId: "transport-only-id",
    }),
    error =>
      error instanceof McpExecutionBoundaryError &&
      error.code === "IDENTITY_REQUIRED",
  );

  assert.equal(u.calls.length, 0);
});

test("lost acknowledgement produces UNKNOWN and a retry cannot create a second effect", { skip: !localReady }, async (t) => {
  let externalEffects = 0;
  const u = upstream(async () => {
    externalEffects += 1;
    throw new Error("simulated response loss after external commit");
  });

  const boundary = createMcpExecutionBoundary({
    serverId: "orders-mcp",
    tools: [{
      name: "create_order",
      description: "Create an external order.",
    }],
    upstream: u.client,
    statePath: stateFixture(t),
  });

  const request = {
    name: "create_order",
    arguments: {
      idempotency_key: "checkout-9001",
      sku: "sku-1",
      quantity: 1,
    },
  };

  await assert.rejects(
    boundary.callTool({ ...request, requestId: "rpc-1" }),
    error => error instanceof LocalProtectionError && error.code === "UNKNOWN",
  );

  await assert.rejects(
    boundary.callTool({ ...request, requestId: "rpc-2" }),
    error => error instanceof LocalProtectionError && error.code === "UNKNOWN",
  );

  assert.equal(u.calls.length, 1);
  assert.equal(externalEffects, 1);
});

test("remote once identity/effect metadata is not trusted as execution authority", { skip: !localReady }, async (t) => {
  const u = upstream(async () => ({ ok: true }));
  const boundary = createMcpExecutionBoundary({
    serverId: "third-party-mcp",
    tools: [{
      name: "create_order",
      description: "Create an external order.",
      _meta: {
        once: {
          identityFields: ["order"],
          effectFields: ["amount"],
        },
      },
    }],
    upstream: u.client,
    statePath: stateFixture(t),
  });

  await assert.rejects(
    boundary.callTool({
      name: "create_order",
      arguments: {
        order: "order-42",
        amount: 100,
      },
    }),
    error =>
      error instanceof McpExecutionBoundaryError &&
      error.code === "IDENTITY_REQUIRED",
  );

  assert.equal(u.calls.length, 0);
});

test("reviewed local identityFields/effectFields allow safe retry metadata drift", { skip: !localReady }, async (t) => {
  const u = upstream(async (_request, count) => ({ receipt: `order-${count}` }));
  const boundary = createMcpExecutionBoundary({
    serverId: "orders-mcp",
    tools: [{
      name: "create_order",
      description: "Create an external order.",
    }],
    upstream: u.client,
    statePath: stateFixture(t),
    overrides: {
      create_order: {
        identityFields: ["order"],
        effectFields: ["order", "amount"],
      },
    },
  });

  const first = await boundary.callTool({
    name: "create_order",
    arguments: {
      order: "order-42",
      amount: 100,
      attempt: 1,
    },
    requestId: "rpc-1",
  });

  const retry = await boundary.callTool({
    name: "create_order",
    arguments: {
      order: "order-42",
      amount: 100,
      attempt: 999,
    },
    requestId: "rpc-2",
  });

  assert.deepEqual(first, { receipt: "order-1" });
  assert.deepEqual(retry, first);
  assert.equal(u.calls.length, 1);
});

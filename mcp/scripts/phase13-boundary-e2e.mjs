import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Client,
  InMemoryTransport,
} from "@modelcontextprotocol/client";

import {
  createMcpExecutionBoundary,
} from "../../sdk/typescript/dist/connect/index.js";
import {
  createMcpProxyServer,
} from "../dist/proxy-server.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "once-mcp-e2e-"));
const statePath = path.join(temp, "operations.sqlite");

let upstreamCalls = 0;
let externalEffects = 0;
let loseNextAcknowledgement = false;

const authoritativeTools = [
  {
    name: "create_order",
    description: "Create an external order.",
    inputSchema: {
      type: "object",
      properties: {
        operation_id: { type: "string" },
        sku: { type: "string" },
        quantity: { type: "number" },
      },
      required: ["operation_id", "sku", "quantity"],
      additionalProperties: false,
    },
    // This remote claim must not grant a bypass at the execution boundary.
    annotations: {
      idempotentHint: true,
    },
  },
];

const boundary = createMcpExecutionBoundary({
  serverId: "phase13-e2e-orders",
  tools: authoritativeTools,
  statePath,
  upstream: {
    async callTool(request) {
      upstreamCalls += 1;
      externalEffects += 1;

      const result = {
        content: [
          {
            type: "text",
            text: `order-${externalEffects}`,
          },
        ],
        structuredContent: {
          receipt: `order-${externalEffects}`,
          sku: request.arguments.sku,
          quantity: request.arguments.quantity,
        },
      };

      if (loseNextAcknowledgement) {
        loseNextAcknowledgement = false;
        throw new Error("simulated lost acknowledgement after external commit");
      }

      return result;
    },
  },
});

assert.equal(boundary.plan.protect.length, 1);
assert.equal(boundary.plan.bypass.length, 0);

const server = createMcpProxyServer({
  boundary,
  name: "once-phase13-e2e",
  version: "0.0.0-test",
});
const client = new Client({
  name: "once-phase13-e2e-client",
  version: "0.0.0-test",
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), ["create_order"]);

  const first = await client.callTool({
    name: "create_order",
    arguments: {
      operation_id: "checkout-42",
      sku: "sku-1",
      quantity: 1,
    },
  });

  const retry = await client.callTool({
    name: "create_order",
    arguments: {
      operation_id: "checkout-42",
      sku: "sku-1",
      quantity: 1,
    },
  });

  assert.deepEqual(retry, first);
  assert.equal(upstreamCalls, 1);
  assert.equal(externalEffects, 1);

  await assert.rejects(
    client.callTool({
      name: "create_order",
      arguments: {
        operation_id: "checkout-42",
        sku: "sku-1",
        quantity: 2,
      },
    }),
  );

  assert.equal(upstreamCalls, 1);
  assert.equal(externalEffects, 1);

  await assert.rejects(
    client.callTool({
      name: "create_order",
      arguments: {
        sku: "sku-no-identity",
        quantity: 1,
      },
    }),
  );

  assert.equal(upstreamCalls, 1);
  assert.equal(externalEffects, 1);

  loseNextAcknowledgement = true;
  const uncertain = {
    name: "create_order",
    arguments: {
      operation_id: "checkout-lost-ack",
      sku: "sku-2",
      quantity: 1,
    },
  };

  await assert.rejects(client.callTool(uncertain));
  assert.equal(upstreamCalls, 2);
  assert.equal(externalEffects, 2);

  await assert.rejects(client.callTool(uncertain));
  assert.equal(upstreamCalls, 2);
  assert.equal(externalEffects, 2);

  console.log("ONCE PHASE 13 MCP END-TO-END: PASS");
  console.log("two downstream retries -> one upstream effect");
  console.log("payload drift -> no additional upstream effect");
  console.log("missing identity -> no upstream dispatch");
  console.log("lost acknowledgement + retry -> one uncertain upstream effect total");
} finally {
  await client.close();
  await server.close();
  rmSync(temp, { recursive: true, force: true });
}

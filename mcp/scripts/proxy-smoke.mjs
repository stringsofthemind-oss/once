import assert from "node:assert/strict";

import {
  Client,
  InMemoryTransport,
} from "@modelcontextprotocol/client";

import {
  createMcpProxyServer,
} from "../dist/proxy-server.js";

const calls = [];

const boundary = {
  listTools() {
    return {
      tools: [
        {
          name: "search_docs",
          description: "Search documentation without changing external state.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        {
          name: "create_order",
          description: "Create an external order through the protected boundary.",
          inputSchema: {
            type: "object",
            properties: {
              operation_id: { type: "string" },
              sku: { type: "string" },
            },
            required: ["operation_id", "sku"],
            additionalProperties: false,
          },
        },
      ],
    };
  },

  async callTool(request) {
    calls.push(request);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            tool: request.name,
            arguments: request.arguments ?? {},
          }),
        },
      ],
      structuredContent: {
        tool: request.name,
        arguments: request.arguments ?? {},
      },
    };
  },
};

const server = createMcpProxyServer({
  boundary,
  name: "once-phase13-proxy-smoke",
  version: "0.0.0-test",
});

const client = new Client({
  name: "once-phase13-proxy-client",
  version: "0.0.0-test",
});

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map(tool => tool.name).sort(),
    ["create_order", "search_docs"],
  );

  const result = await client.callTool({
    name: "create_order",
    arguments: {
      operation_id: "order-42",
      sku: "sku-1",
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    tool: "create_order",
    arguments: {
      operation_id: "order-42",
      sku: "sku-1",
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "create_order");
  assert.deepEqual(calls[0].arguments, {
    operation_id: "order-42",
    sku: "sku-1",
  });
  assert.notEqual(calls[0].requestId, undefined);

  console.log("ONCE MCP PROXY SMOKE: PASS");
  console.log("Downstream tools/list crossed the proxy boundary");
  console.log("Downstream tools/call crossed the proxy boundary");
  console.log("Transport request id observed only as boundary correlation metadata");
} finally {
  await client.close();
  await server.close();
}

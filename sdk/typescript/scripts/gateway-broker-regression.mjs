import assert from "node:assert/strict";

import {
  GatewayConnectionError,
  connectLocalGatewayToolsetAuto,
} from "../dist/gateway/index.js";

console.log("");
console.log("ONCE PHASE 11E LOCAL GATEWAY BROKER REGRESSION");
console.log("===============================================");

let directCalls = 0;
const directTool = {
  async execute(input) {
    directCalls += 1;
    return { query: input.query, receiver: this === directTool };
  },
};

const directRegistry = { search_orders: directTool };
const direct = connectLocalGatewayToolsetAuto(directRegistry, {
  manifest: [
    {
      name: "search_orders",
      description: "Search customer orders",
      inputSchema: { type: "object" },
    },
  ],
});

assert.equal(direct.plan.ready, true);
assert.equal(direct.plan.entries[0].route, "DIRECT");
assert.equal(Object.isFrozen(direct), true);
assert.equal(Object.isFrozen(direct.tools), true);
assert.notEqual(direct.tools, directRegistry);
const directResult = await direct.tools.search_orders.execute({ query: "abc" });
assert.deepEqual(directResult, { query: "abc", receiver: true });
assert.equal(directCalls, 1);
console.log("PASS - DIRECT route preserves original tool execution semantics");

let blockedCalls = 0;
const blockedRegistry = {
  search_orders: {
    async execute() {
      blockedCalls += 1;
      return "search";
    },
  },
  search_update_records: {
    async execute() {
      blockedCalls += 1;
      return "ambiguous";
    },
  },
};

assert.throws(
  () => connectLocalGatewayToolsetAuto(blockedRegistry, {
    manifest: [
      { name: "search_orders", description: "Search orders" },
      { name: "search_update_records", description: "Search and update records" },
    ],
  }),
  error =>
    error instanceof GatewayConnectionError &&
    error.code === "GATEWAY_BLOCKED",
);
assert.equal(blockedCalls, 0);
console.log("PASS - unresolved selected subset blocks before any tool executes");

const sendTool = {
  async execute(input) {
    return input;
  },
};

const protectedWiring = connectLocalGatewayToolsetAuto(
  { send_email: sendTool },
  {
    manifest: [
      { name: "send_email", description: "Sends an external email" },
    ],
  },
);
assert.equal(protectedWiring.plan.entries[0].route, "PROTECT");
assert.notEqual(protectedWiring.tools.send_email, sendTool);
console.log("PASS - PROTECT route is wired through the existing Connect wrapper");

assert.throws(
  () => connectLocalGatewayToolsetAuto(
    {},
    {
      manifest: [
        { name: "search_orders", description: "Search orders" },
      ],
    },
  ),
  error => error?.code === "MISSING_TOOL_IMPLEMENTATION",
);
console.log("PASS - missing implementation fails through Connect preflight");

assert.throws(
  () => connectLocalGatewayToolsetAuto(
    {
      search_orders: directTool,
      hidden_write: {
        async execute() {
          blockedCalls += 1;
        },
      },
    },
    {
      manifest: [
        { name: "search_orders", description: "Search orders" },
      ],
    },
  ),
  error => error?.code === "UNDECLARED_TOOL_IMPLEMENTATION",
);
assert.equal(blockedCalls, 0);
console.log("PASS - undeclared executable bypass surface is rejected");

assert.throws(
  () => connectLocalGatewayToolsetAuto(
    directRegistry,
    // Deliberately omit manifest.
    {},
  ),
  error =>
    error instanceof GatewayConnectionError &&
    error.code === "INVALID_GATEWAY_MANIFEST",
);
console.log("PASS - missing gateway manifest fails closed");

console.log("phase11e local gateway broker regression: PASS");

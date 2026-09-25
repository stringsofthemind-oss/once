import assert from "node:assert/strict";

import {
  GatewayConnectionError,
  bindGatewayPlanToToolGraph,
  connectLocalGatewayToolsetAuto,
  planGatewayToolset,
} from "../dist/gateway/index.js";

console.log("");
console.log("ONCE PHASE 11E TOOL GRAPH BINDING REGRESSION");
console.log("============================================");

const manifest = [
  { name: "search_orders", description: "Search customer orders" },
  { name: "send_email", description: "Sends an external email" },
];
const plan = planGatewayToolset(manifest);
assert.equal(plan.ready, true);

const bindings = [
  {
    toolId: "tool:search",
    namespacedName: "runtime/search_orders",
    canonicalName: "search_orders",
    descriptorFingerprint: plan.entries[0].descriptorFingerprint,
    evidenceLevel: "MODEL_VISIBLE",
    actionPriorityScore: 5,
    protection: "NONE",
  },
  {
    toolId: "tool:send",
    namespacedName: "runtime/send_email",
    canonicalName: "send_email",
    descriptorFingerprint: plan.entries[1].descriptorFingerprint,
    evidenceLevel: "EXECUTED",
    actionPriorityScore: 99,
    protection: "ONCE_HEALTHY",
  },
  {
    toolId: "tool:unrelated",
    namespacedName: "global/delete_everything",
    canonicalName: "delete_everything",
    descriptorFingerprint: "f".repeat(64),
    evidenceLevel: "EXECUTED",
    actionPriorityScore: 100,
    protection: "NONE",
  },
];

const bound = bindGatewayPlanToToolGraph(plan, bindings);
assert.equal(bound.ready, true);
assert.equal(bound.entries.length, 2);
assert.equal(bound.summary.matched, 2);
assert.equal(bound.summary.blocked, 0);
assert.equal(bound.entries[0].toolGraph.toolId, "tool:search");
assert.equal(bound.entries[1].toolGraph.toolId, "tool:send");
assert.equal(bound.entries[0].route, "DIRECT");
assert.equal(bound.entries[1].route, "PROTECT");
assert.equal(bound.entries[1].toolGraph.evidenceLevel, "EXECUTED");
assert.equal(bound.entries[1].toolGraph.protection, "ONCE_HEALTHY");
console.log("PASS - exact selected bindings match while unrelated global catalog entries stay out");
console.log("PASS - evidence/protection metadata cannot downgrade PROTECT to DIRECT");

const missing = bindGatewayPlanToToolGraph(plan, bindings.slice(0, 1));
assert.equal(missing.ready, false);
assert.equal(missing.entries[1].bindingStatus, "MISSING");
assert.equal(missing.entries[1].route, "BLOCK");
console.log("PASS - missing Tool Graph identity blocks the selected tool");

const stale = bindGatewayPlanToToolGraph(plan, [
  bindings[0],
  {
    ...bindings[1],
    descriptorFingerprint: "0".repeat(64),
  },
]);
assert.equal(stale.ready, false);
assert.equal(stale.entries[1].bindingStatus, "FINGERPRINT_MISMATCH");
assert.equal(stale.entries[1].route, "BLOCK");
console.log("PASS - stale/same-name descriptor mismatch fails closed");

const ambiguous = bindGatewayPlanToToolGraph(plan, [
  bindings[0],
  bindings[1],
  {
    ...bindings[1],
    toolId: "tool:send-duplicate",
    namespacedName: "other/send_email",
  },
]);
assert.equal(ambiguous.ready, false);
assert.equal(ambiguous.entries[1].bindingStatus, "AMBIGUOUS");
assert.equal(ambiguous.entries[1].route, "BLOCK");
console.log("PASS - duplicate exact Tool Graph identity is not resolved by array order");

const alreadyBlockedPlan = planGatewayToolset([
  { name: "search_update_records", description: "Search and update records" },
]);
const alreadyBlocked = bindGatewayPlanToToolGraph(alreadyBlockedPlan, []);
assert.equal(alreadyBlocked.ready, false);
assert.equal(alreadyBlocked.entries[0].bindingStatus, "NOT_ROUTABLE");
assert.equal(alreadyBlocked.entries[0].route, "BLOCK");
console.log("PASS - Tool Graph binding cannot rescue an UNKNOWN/BLOCK route");

let executeCount = 0;
const registry = {
  search_orders: {
    async execute(input) {
      executeCount += 1;
      return input;
    },
  },
  send_email: {
    async execute(input) {
      executeCount += 1;
      return input;
    },
  },
};

const wired = connectLocalGatewayToolsetAuto(registry, {
  manifest,
  toolGraphBindings: bindings,
});
assert.equal(wired.binding?.ready, true);
assert.equal(wired.binding?.entries.length, 2);
assert.equal(executeCount, 0);
console.log("PASS - exact Tool Graph binding is enforced before broker wrappers escape");

assert.throws(
  () => connectLocalGatewayToolsetAuto(registry, {
    manifest,
    toolGraphBindings: [bindings[0], { ...bindings[1], descriptorFingerprint: "1".repeat(64) }],
  }),
  error =>
    error instanceof GatewayConnectionError &&
    error.code === "GATEWAY_TOOL_GRAPH_BLOCKED",
);
assert.equal(executeCount, 0);
console.log("PASS - broker refuses stale Tool Graph binding before execution");

console.log("phase11e Tool Graph binding regression: PASS");

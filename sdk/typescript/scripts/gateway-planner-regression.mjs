import assert from "node:assert/strict";

import {
  GATEWAY_ROUTE,
  gatewayDescriptorFingerprint,
  planGatewayToolset,
} from "../dist/gateway/index.js";

console.log("");
console.log("ONCE PHASE 11E GATEWAY PLANNER REGRESSION");
console.log("==========================================");

const manifest = [
  {
    name: "search_orders",
    description: "Look up customer orders",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  },
  {
    name: "send_email",
    description: "Sends an external customer email",
    inputSchema: {
      type: "object",
      properties: {
        idempotencyKey: { type: "string" },
        to: { type: "string" },
        body: { type: "string" },
      },
    },
  },
  {
    name: "search_update_records",
    description: "Search and update records",
    inputSchema: { type: "object" },
  },
];

const plan = planGatewayToolset(manifest);
assert.equal(plan.valid, true);
assert.equal(plan.ready, false);
assert.equal(plan.summary.total, 3);
assert.equal(plan.summary.direct, 1);
assert.equal(plan.summary.protect, 1);
assert.equal(plan.summary.blocked, 1);
assert.equal(plan.entries[0].route, GATEWAY_ROUTE.DIRECT);
assert.equal(plan.entries[1].route, GATEWAY_ROUTE.PROTECT);
assert.equal(plan.entries[2].route, GATEWAY_ROUTE.BLOCK);
assert.equal(plan.entries[0].connectDecision, "BYPASS");
assert.equal(plan.entries[1].connectDecision, "PROTECT");
assert.equal(plan.entries[2].connectDecision, "UNKNOWN");
assert.equal(plan.blocked[0].connectReason, "CONFLICTING_SIGNALS");
console.log("PASS - Connect classification maps deterministically to DIRECT/PROTECT/BLOCK");

assert.equal(Object.isFrozen(plan), true);
assert.equal(Object.isFrozen(plan.entries), true);
assert.equal(Object.isFrozen(plan.entries[0]), true);
assert.equal(Object.isFrozen(plan.entries[0].signals), true);
console.log("PASS - gateway plan is immutable");

const invalid = planGatewayToolset({ notTools: [] });
assert.equal(invalid.valid, false);
assert.equal(invalid.ready, false);
assert.equal(invalid.reason, "INVALID_MANIFEST");
assert.equal(invalid.entries.length, 0);
console.log("PASS - invalid manifest fails closed");

const ready = planGatewayToolset(manifest.slice(0, 2));
assert.equal(ready.valid, true);
assert.equal(ready.ready, true);
assert.equal(ready.summary.blocked, 0);
console.log("PASS - only the supplied runtime-selected subset must be route-ready");

const descriptorA = {
  name: "send_email",
  description: "Sends email",
  inputSchema: {
    type: "object",
    properties: {
      body: { type: "string" },
      api_key: { type: "string", default: "secret-one" },
    },
  },
};
const descriptorB = {
  description: "Sends email",
  inputSchema: {
    properties: {
      api_key: { default: "secret-two", type: "string" },
      body: { type: "string" },
    },
    type: "object",
  },
  name: "send_email",
};
const descriptorC = {
  ...descriptorA,
  inputSchema: {
    type: "object",
    properties: {
      body: { type: "number" },
      api_key: { type: "string", default: "secret-three" },
    },
  },
};

const fingerprintA = gatewayDescriptorFingerprint(descriptorA);
const fingerprintB = gatewayDescriptorFingerprint(descriptorB);
const fingerprintC = gatewayDescriptorFingerprint(descriptorC);
assert.equal(fingerprintA, fingerprintB);
assert.notEqual(fingerprintA, fingerprintC);
assert.match(fingerprintA, /^[a-f0-9]{64}$/);
console.log("PASS - fingerprint is key-order stable, schema-sensitive, and secret-value insensitive");

let getterReads = 0;
const getterDescriptor = { name: "send_email" };
Object.defineProperty(getterDescriptor, "credential", {
  enumerable: true,
  get() {
    getterReads += 1;
    return "must-not-be-read";
  },
});
gatewayDescriptorFingerprint(getterDescriptor);
assert.equal(getterReads, 0);
console.log("PASS - fingerprinting does not evaluate getter-backed descriptor state");

let executeCount = 0;
const descriptorWithFunction = {
  name: "send_email",
  description: "Sends email",
  execute() {
    executeCount += 1;
  },
};
planGatewayToolset([descriptorWithFunction]);
assert.equal(executeCount, 0);
console.log("PASS - planning never executes tool implementations");

const openAiPlan = planGatewayToolset({
  tools: [
    {
      type: "function",
      function: {
        name: "search_web",
        description: "Search the web",
        parameters: { type: "object" },
      },
    },
  ],
});
assert.equal(openAiPlan.valid, true);
assert.equal(openAiPlan.ready, true);
assert.equal(openAiPlan.entries[0].source, "openai_function");
assert.equal(openAiPlan.entries[0].route, "DIRECT");
console.log("PASS - OpenAI function manifests use the same gateway route model");

console.log("phase11e gateway planner regression: PASS");

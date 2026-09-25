import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveConnectToolOperationIdentity,
} from "@once-agent/sdk/connect";

const tool = { name: "send_email" };

test("finds conventional idempotency identity", () => {
  const result = resolveConnectToolOperationIdentity({
    tool,
    input: { idempotencyKey: "invoice-42", to: "test@example.invalid" },
  });
  assert.equal(result.status, "FOUND");
  assert.equal(result.source, "input:idempotencyKey");
  assert.match(result.operationId, /^send_email:[a-f0-9]{32}$/);
});

test("finds conventional logical operation identity", () => {
  const result = resolveConnectToolOperationIdentity({
    tool,
    input: { operation_id: "refund-order-99" },
  });
  assert.equal(result.status, "FOUND");
  assert.equal(result.source, "input:operation_id");
});

test("finds conventional intent identity", () => {
  const result = resolveConnectToolOperationIdentity({
    tool,
    input: { intentId: "user-intent-123" },
  });
  assert.equal(result.status, "FOUND");
  assert.equal(result.source, "input:intentId");
});

test("same tool and same identity produce the same operation ID", () => {
  const first = resolveConnectToolOperationIdentity({
    tool,
    input: { idempotency_key: "same-intent" },
  });
  const second = resolveConnectToolOperationIdentity({
    tool,
    input: { idempotency_key: "same-intent", transport_attempt: 7 },
  });
  assert.equal(first.status, "FOUND");
  assert.equal(second.status, "FOUND");
  assert.equal(first.operationId, second.operationId);
});

test("same identity is scoped to the tool name", () => {
  const first = resolveConnectToolOperationIdentity({
    tool: { name: "send_email" },
    input: { intent_id: "intent-1" },
  });
  const second = resolveConnectToolOperationIdentity({
    tool: { name: "charge_customer" },
    input: { intent_id: "intent-1" },
  });
  assert.equal(first.status, "FOUND");
  assert.equal(second.status, "FOUND");
  assert.notEqual(first.operationId, second.operationId);
});

test("multiple trustworthy carriers may agree", () => {
  const result = resolveConnectToolOperationIdentity({
    tool,
    explicitIdentity: "intent-1",
    input: { operationId: "intent-1", idempotencyKey: "intent-1" },
  });
  assert.equal(result.status, "FOUND");
  assert.equal(result.source, "explicit");
});

test("disagreeing trustworthy carriers fail closed", () => {
  const result = resolveConnectToolOperationIdentity({
    tool,
    explicitIdentity: "intent-A",
    input: { idempotencyKey: "intent-B" },
  });
  assert.equal(result.status, "CONFLICT");
  assert.deepEqual(result.sources, ["explicit", "input:idempotencyKey"]);
});

test("generic request IDs are not mistaken for logical-operation identity", () => {
  const result = resolveConnectToolOperationIdentity({
    tool,
    input: { requestId: "transport-attempt-123", callId: "tool-call-456", id: "object-789" },
  });
  assert.equal(result.status, "REQUIRED");
});

test("payload equality is not treated as proof of same intent", () => {
  const input = { to: "test@example.invalid", subject: "Invoice", body: "Same body" };
  const first = resolveConnectToolOperationIdentity({ tool, input });
  const second = resolveConnectToolOperationIdentity({ tool, input: { ...input } });
  assert.equal(first.status, "REQUIRED");
  assert.equal(second.status, "REQUIRED");
});

test("tool metadata may explicitly declare composite identity fields", () => {
  const result = resolveConnectToolOperationIdentity({
    tool: {
      name: "send_email",
      _meta: { once: { identityFields: ["tenant", "intent"] } },
    },
    input: { tenant: "acme", intent: "invoice-42", retry: 3 },
  });
  assert.equal(result.status, "FOUND");
  assert.equal(result.source, "meta:identity_fields");
});

test("metadata composite identity ignores unrelated retry fields", () => {
  const descriptor = {
    name: "send_email",
    _meta: { once: { identityFields: ["tenant", "intent"] } },
  };
  const first = resolveConnectToolOperationIdentity({
    tool: descriptor,
    input: { tenant: "acme", intent: "invoice-42", attempt: 1 },
  });
  const second = resolveConnectToolOperationIdentity({
    tool: descriptor,
    input: { tenant: "acme", intent: "invoice-42", attempt: 9 },
  });
  assert.equal(first.status, "FOUND");
  assert.equal(second.status, "FOUND");
  assert.equal(first.operationId, second.operationId);
});

test("metadata identity fails closed when a declared field is absent", () => {
  const result = resolveConnectToolOperationIdentity({
    tool: {
      name: "send_email",
      _meta: { once: { identityFields: ["tenant", "intent"] } },
    },
    input: { tenant: "acme" },
  });
  assert.equal(result.status, "REQUIRED");
});

test("invalid metadata identity fields do not become permission", () => {
  const result = resolveConnectToolOperationIdentity({
    tool: {
      name: "send_email",
      _meta: { once: { identityFields: ["tenant.id"] } },
    },
    input: { "tenant.id": "acme" },
  });
  assert.equal(result.status, "REQUIRED");
});

test("explicit identity is deterministic even when unrelated input changes", () => {
  const first = resolveConnectToolOperationIdentity({
    tool,
    explicitIdentity: "logical-intent",
    input: { body: "A" },
  });
  const second = resolveConnectToolOperationIdentity({
    tool,
    explicitIdentity: "logical-intent",
    input: { body: "B" },
  });
  assert.equal(first.status, "FOUND");
  assert.equal(second.status, "FOUND");
  assert.equal(first.operationId, second.operationId);
});

test("invalid tool or input fails closed", () => {
  assert.equal(
    resolveConnectToolOperationIdentity({ tool: { name: "" }, input: {} }).status,
    "REQUIRED",
  );
  assert.equal(
    resolveConnectToolOperationIdentity({ tool, input: null }).status,
    "REQUIRED",
  );
});

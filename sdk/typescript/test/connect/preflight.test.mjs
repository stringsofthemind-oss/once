import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECT_PREFLIGHT_VERSION,
  prepareConnectToolCall,
} from "@once-agent/sdk/connect";

test("safe read bypasses without requiring identity", () => {
  const result = prepareConnectToolCall({
    descriptor: {
      name: "search_web",
      description: "Search the public web.",
    },
    input: {
      query: "once",
    },
  });

  assert.equal(result.version, CONNECT_PREFLIGHT_VERSION);
  assert.equal(result.decision, "BYPASS");
  assert.equal(result.code, "TOOL_BYPASS");
  assert.equal(result.consequential, false);
  assert.equal(result.operationId, undefined);
  assert.equal(result.payloadFingerprint, undefined);
});

test("consequential tool with trustworthy identity is ready to protect", () => {
  const result = prepareConnectToolCall({
    descriptor: {
      name: "send_email",
      description: "Send an email to a recipient.",
    },
    input: {
      idempotencyKey: "invoice-42",
      to: "test@example.invalid",
      body: "Invoice",
    },
  });

  assert.equal(result.decision, "PROTECT");
  assert.equal(result.code, "TOOL_PROTECT");
  assert.equal(result.consequential, true);
  assert.equal(result.identitySource, "input:idempotencyKey");
  assert.equal(result.payloadSource, "full_input");
  assert.match(result.operationId, /^send_email:[a-f0-9]{32}$/);
  assert.match(
    result.payloadFingerprint,
    /^once-connect-payload-v1:[a-f0-9]{64}$/,
  );
  assert.deepEqual(result.payload, {
    body: "Invoice",
    idempotencyKey: "invoice-42",
    to: "test@example.invalid",
  });
});

test("unknown tool semantics block", () => {
  const result = prepareConnectToolCall({
    descriptor: { name: "frobnicate_account" },
    input: { operationId: "intent-1" },
  });

  assert.equal(result.decision, "BLOCK");
  assert.equal(result.code, "TOOL_SAFETY_UNKNOWN");
});

test("missing write identity blocks before payload is relevant", () => {
  const result = prepareConnectToolCall({
    descriptor: {
      name: "send_email",
      description: "Send an email to a recipient.",
    },
    input: {
      to: "test@example.invalid",
      body: "Invoice",
    },
  });

  assert.equal(result.decision, "BLOCK");
  assert.equal(result.code, "IDENTITY_REQUIRED");
  assert.equal(result.consequential, true);
});

test("conflicting identity carriers block", () => {
  const result = prepareConnectToolCall({
    descriptor: {
      name: "charge_customer",
      description: "Charge a customer for an order.",
    },
    input: {
      operationId: "charge-A",
      idempotencyKey: "charge-B",
      amount: 100,
    },
  });

  assert.equal(result.decision, "BLOCK");
  assert.equal(result.code, "IDENTITY_CONFLICT");
});

test("non-JSON-safe automatic payload blocks", () => {
  const result = prepareConnectToolCall({
    descriptor: {
      name: "send_email",
      description: "Send an email to a recipient.",
    },
    input: {
      idempotencyKey: "invoice-42",
      callback() {},
    },
  });

  assert.equal(result.decision, "BLOCK");
  assert.equal(result.code, "PAYLOAD_REQUIRED");
});

test("explicit identity and payload can prepare a protected call", () => {
  const result = prepareConnectToolCall({
    descriptor: {
      name: "send_email",
      description: "Send an email to a recipient.",
    },
    explicitIdentity: "invoice-42",
    input: {
      requestId: "transport-7",
      to: "test@example.invalid",
    },
    payload: {
      to: "test@example.invalid",
      body: "Invoice",
    },
  });

  assert.equal(result.decision, "PROTECT");
  assert.equal(result.identitySource, "explicit");
  assert.equal(result.payloadSource, "explicit");
  assert.deepEqual(result.payload, {
    body: "Invoice",
    to: "test@example.invalid",
  });
});

test("invalid explicit payload blocks", () => {
  const result = prepareConnectToolCall({
    descriptor: {
      name: "send_email",
      description: "Send an email to a recipient.",
    },
    explicitIdentity: "invoice-42",
    input: {},
    payload: {
      value: undefined,
    },
  });

  assert.equal(result.decision, "BLOCK");
  assert.equal(result.code, "PAYLOAD_REQUIRED");
});

test("effectFields make payload fingerprint stable across retry metadata", () => {
  const descriptor = {
    name: "send_email",
    description: "Send an email to a recipient.",
    _meta: {
      once: {
        effectFields: ["to", "body"],
      },
    },
  };

  const first = prepareConnectToolCall({
    descriptor,
    input: {
      idempotencyKey: "invoice-42",
      to: "test@example.invalid",
      body: "Invoice",
      attempt: 1,
    },
  });

  const retry = prepareConnectToolCall({
    descriptor,
    input: {
      idempotencyKey: "invoice-42",
      to: "test@example.invalid",
      body: "Invoice",
      attempt: 9,
    },
  });

  assert.equal(first.decision, "PROTECT");
  assert.equal(retry.decision, "PROTECT");
  assert.equal(first.operationId, retry.operationId);
  assert.equal(first.payloadFingerprint, retry.payloadFingerprint);
  assert.equal(first.payloadSource, "meta:effect_fields");
});

test("full-input fallback exposes retry metadata drift through fingerprint", () => {
  const descriptor = {
    name: "send_email",
    description: "Send an email to a recipient.",
  };

  const first = prepareConnectToolCall({
    descriptor,
    input: {
      idempotencyKey: "invoice-42",
      to: "test@example.invalid",
      attempt: 1,
    },
  });

  const retry = prepareConnectToolCall({
    descriptor,
    input: {
      idempotencyKey: "invoice-42",
      to: "test@example.invalid",
      attempt: 2,
    },
  });

  assert.equal(first.decision, "PROTECT");
  assert.equal(retry.decision, "PROTECT");
  assert.equal(first.operationId, retry.operationId);
  assert.notEqual(first.payloadFingerprint, retry.payloadFingerprint);
});

test("preflight is deterministic and performs no mutation", () => {
  const input = {
    idempotencyKey: "invoice-42",
    nested: { value: 1 },
  };

  const descriptor = {
    name: "send_email",
    description: "Send an email to a recipient.",
  };

  const first = prepareConnectToolCall({ descriptor, input });
  const second = prepareConnectToolCall({ descriptor, input });

  assert.deepEqual(first, second);
  assert.deepEqual(input, {
    idempotencyKey: "invoice-42",
    nested: { value: 1 },
  });
  assert.equal(Object.isFrozen(first), true);
});

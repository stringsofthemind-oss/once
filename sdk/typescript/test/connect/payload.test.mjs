import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveConnectToolEffectPayload,
} from "@once-agent/sdk/connect";

const tool = { name: "send_email" };

test("plain-object input is conservatively bound in full", () => {
  const result = resolveConnectToolEffectPayload({
    tool,
    input: {
      idempotencyKey: "invoice-42",
      to: "test@example.invalid",
      body: "Invoice",
    },
  });

  assert.equal(result.status, "FOUND");
  assert.equal(result.source, "full_input");
  assert.deepEqual(result.payload, {
    body: "Invoice",
    idempotencyKey: "invoice-42",
    to: "test@example.invalid",
  });
});

test("full-input binding is deterministic across key order", () => {
  const first = resolveConnectToolEffectPayload({
    tool,
    input: { a: 1, b: 2 },
  });
  const second = resolveConnectToolEffectPayload({
    tool,
    input: { b: 2, a: 1 },
  });

  assert.equal(first.status, "FOUND");
  assert.equal(second.status, "FOUND");
  assert.deepEqual(first.payload, second.payload);
});

test("effectFields narrows binding to explicit top-level effect data", () => {
  const result = resolveConnectToolEffectPayload({
    tool: {
      name: "send_email",
      _meta: {
        once: {
          effectFields: ["to", "body"],
        },
      },
    },
    input: {
      idempotencyKey: "invoice-42",
      to: "test@example.invalid",
      body: "Invoice",
      attempt: 9,
    },
  });

  assert.equal(result.status, "FOUND");
  assert.equal(result.source, "meta:effect_fields");
  assert.deepEqual(result.payload, {
    body: "Invoice",
    to: "test@example.invalid",
  });
});

test("missing declared effect field fails closed", () => {
  const result = resolveConnectToolEffectPayload({
    tool: {
      name: "send_email",
      _meta: {
        once: {
          effectFields: ["to", "body"],
        },
      },
    },
    input: {
      to: "test@example.invalid",
    },
  });

  assert.equal(result.status, "REQUIRED");
});

test("invalid effectFields metadata fails closed", () => {
  for (const effectFields of [
    [],
    [""],
    ["nested.path"],
    ["to", "to"],
    "to",
  ]) {
    const result = resolveConnectToolEffectPayload({
      tool: {
        name: "send_email",
        _meta: {
          once: { effectFields },
        },
      },
      input: {
        to: "test@example.invalid",
      },
    });

    assert.equal(result.status, "REQUIRED");
  }
});

test("non-object input requires an explicit payload selector", () => {
  for (const input of [null, "text", 42, ["array"]]) {
    assert.equal(
      resolveConnectToolEffectPayload({ tool, input }).status,
      "REQUIRED",
    );
  }
});

test("non-JSON-safe input does not become an automatic payload", () => {
  const result = resolveConnectToolEffectPayload({
    tool,
    input: {
      to: "test@example.invalid",
      callback() {},
    },
  });

  assert.equal(result.status, "REQUIRED");
});

test("returned payload is a detached frozen snapshot", () => {
  const input = {
    nested: {
      value: 1,
    },
  };

  const result = resolveConnectToolEffectPayload({ tool, input });

  assert.equal(result.status, "FOUND");
  assert.equal(Object.isFrozen(result.payload), true);
  assert.notEqual(result.payload, input);
  input.nested.value = 2;
  assert.deepEqual(result.payload, {
    nested: {
      value: 1,
    },
  });
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectBindingError,
  assertConnectBindingMatch,
  bindConnectOperation,
  fingerprintConnectPayload,
} from "../../src/connect/binding.js";

test("identical consequential payloads produce identical fingerprints", () => {
  const a = fingerprintConnectPayload({
    orderId: "order_123",
    amount: 1000,
    currency: "GBP",
  });

  const b = fingerprintConnectPayload({
    currency: "GBP",
    amount: 1000,
    orderId: "order_123",
  });

  assert.equal(a, b);
});

test("object key order does not change the fingerprint", () => {
  const a = fingerprintConnectPayload({
    outer: {
      z: 3,
      a: 1,
    },
  });

  const b = fingerprintConnectPayload({
    outer: {
      a: 1,
      z: 3,
    },
  });

  assert.equal(a, b);
});

test("array order remains consequential", () => {
  const a = fingerprintConnectPayload({
    items: ["a", "b"],
  });

  const b = fingerprintConnectPayload({
    items: ["b", "a"],
  });

  assert.notEqual(a, b);
});

test("changed consequential payload produces a different fingerprint", () => {
  const ten = fingerprintConnectPayload({
    orderId: "order_123",
    amount: 1000,
  });

  const hundred = fingerprintConnectPayload({
    orderId: "order_123",
    amount: 10000,
  });

  assert.notEqual(ten, hundred);
});

test("same identity and same payload matches", () => {
  const first = bindConnectOperation({
    operationId: "refund:order_123",
    payload: {
      amount: 1000,
      currency: "GBP",
    },
  });

  const retry = bindConnectOperation({
    operationId: "refund:order_123",
    payload: {
      currency: "GBP",
      amount: 1000,
    },
  });

  assert.equal(
    assertConnectBindingMatch(first, retry),
    true,
  );
});

test("same identity with payload drift is rejected", () => {
  const first = bindConnectOperation({
    operationId: "refund:order_123",
    payload: {
      amount: 1000,
    },
  });

  const driftedRetry = bindConnectOperation({
    operationId: "refund:order_123",
    payload: {
      amount: 10000,
    },
  });

  assert.throws(
    () =>
      assertConnectBindingMatch(
        first,
        driftedRetry,
      ),
    (error) =>
      error instanceof ConnectBindingError &&
      error.code === "PAYLOAD_DRIFT",
  );
});

test("different logical operation identities do not match", () => {
  const a = bindConnectOperation({
    operationId: "refund:order_123",
    payload: {
      amount: 1000,
    },
  });

  const b = bindConnectOperation({
    operationId: "refund:order_124",
    payload: {
      amount: 1000,
    },
  });

  assert.throws(
    () => assertConnectBindingMatch(a, b),
    (error) =>
      error instanceof ConnectBindingError &&
      error.code === "OPERATION_ID_MISMATCH",
  );
});

test("unsupported payload values fail closed", () => {
  assert.throws(
    () =>
      fingerprintConnectPayload({
        amount: Number.NaN,
      }),
    (error) =>
      error instanceof ConnectBindingError &&
      error.code === "UNSUPPORTED_PAYLOAD_VALUE",
  );

  assert.throws(
    () =>
      fingerprintConnectPayload({
        callback() {},
      }),
    (error) =>
      error instanceof ConnectBindingError &&
      error.code === "UNSUPPORTED_PAYLOAD_VALUE",
  );
});

test("missing operation identity fails closed", () => {
  assert.throws(
    () =>
      bindConnectOperation({
        operationId: "",
        payload: {
          amount: 1000,
        },
      }),
    (error) =>
      error instanceof ConnectBindingError &&
      error.code === "INVALID_OPERATION_ID",
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  ConnectExecutionError,
  executeConnectOperation,
} from "../../dist/connect/execute.js";

const protectedSafety = {
  changesExternalState: true,
  retryPossible: true,
  ambiguousOutcomePossible: true,
  duplicateUndesirable: true,
};

test("protected operation crosses the protection boundary exactly once", async () => {
  let bypassCalls = 0;
  let protectCalls = 0;

  const result =
    await executeConnectOperation({
      safety: protectedSafety,
      operationId: "refund:order_123",
      payload: {
        orderId: "order_123",
        amount: 1000,
      },

      bypass: async () => {
        bypassCalls += 1;
        return "BYPASSED";
      },

      protect: async (context) => {
        protectCalls += 1;

        assert.equal(
          context.operationId,
          "refund:order_123",
        );

        assert.match(
          context.payloadFingerprint,
          /^once-connect-payload-v1:[a-f0-9]{64}$/,
        );

        assert.equal(
          context.classification.decision,
          "PROTECT",
        );

        return "PROTECTED";
      },
    });

  assert.equal(result, "PROTECTED");
  assert.equal(protectCalls, 1);
  assert.equal(bypassCalls, 0);
});

test("safe bypass never enters protected execution", async () => {
  let bypassCalls = 0;
  let protectCalls = 0;

  const result =
    await executeConnectOperation({
      safety: {
        changesExternalState: false,
        retryPossible: true,
        ambiguousOutcomePossible: true,
        duplicateUndesirable: true,
      },

      operationId: "read:order_123",

      payload: {
        orderId: "order_123",
      },

      bypass: async () => {
        bypassCalls += 1;
        return "BYPASSED";
      },

      protect: async () => {
        protectCalls += 1;
        return "PROTECTED";
      },
    });

  assert.equal(result, "BYPASSED");
  assert.equal(bypassCalls, 1);
  assert.equal(protectCalls, 0);
});

test("invalid safety declaration executes nothing", async () => {
  let executions = 0;

  await assert.rejects(
    () =>
      executeConnectOperation({
        safety: {
          changesExternalState: true,
        },

        operationId: "refund:order_123",

        payload: {
          amount: 1000,
        },

        bypass: async () => {
          executions += 1;
        },

        protect: async () => {
          executions += 1;
        },
      }),

    (error) =>
      error instanceof ConnectExecutionError &&
      error.code === "CONNECT_REJECTED",
  );

  assert.equal(executions, 0);
});

test("protected operation without stable identity executes nothing", async () => {
  let executions = 0;

  await assert.rejects(
    () =>
      executeConnectOperation({
        safety: protectedSafety,
        operationId: "",
        payload: {
          amount: 1000,
        },

        bypass: async () => {
          executions += 1;
        },

        protect: async () => {
          executions += 1;
        },
      }),
  );

  assert.equal(executions, 0);
});

test("protected operation without protector fails closed", async () => {
  await assert.rejects(
    () =>
      executeConnectOperation({
        safety: protectedSafety,
        operationId: "refund:order_123",
        payload: {
          amount: 1000,
        },
      }),

    (error) =>
      error instanceof ConnectExecutionError &&
      error.code === "PROTECT_HANDLER_MISSING",
  );
});

test("bypass operation without bypass handler fails closed", async () => {
  await assert.rejects(
    () =>
      executeConnectOperation({
        safety: {
          changesExternalState: false,
          retryPossible: false,
          ambiguousOutcomePossible: false,
          duplicateUndesirable: false,
        },

        operationId: "read:order_123",

        payload: {
          orderId: "order_123",
        },
      }),

    (error) =>
      error instanceof ConnectExecutionError &&
      error.code === "BYPASS_HANDLER_MISSING",
  );
});

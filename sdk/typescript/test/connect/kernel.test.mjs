import test from "node:test";
import assert from "node:assert/strict";

import {
  ConnectKernelError,
  executeConnectWithOnce,
} from "../../src/connect/kernel.js";

const protectedSafety = {
  changesExternalState: true,
  retryPossible: true,
  ambiguousOutcomePossible: true,
  duplicateUndesirable: true,
};

test("protected Connect execution delegates exactly once to Once.execute", async () => {
  const calls = [];

  const once = {
    async execute(input) {
      calls.push(input);

      return {
        state: "CONFIRMED",
        receipt: {
          id: "receipt_123",
        },
      };
    },
  };

  let bypassCalls = 0;

  const result =
    await executeConnectWithOnce({
      once,
      provider: "stripe-test",
      safety: protectedSafety,
      operationId: "refund:order_123",

      payload: {
        orderId: "order_123",
        amount: 1000,
      },

      action: {
        type: "refund",
        order_id: "order_123",
        amount: 1000,
      },

      bypass: async () => {
        bypassCalls += 1;
        return "BYPASSED";
      },
    });

  assert.equal(calls.length, 1);
  assert.equal(bypassCalls, 0);

  assert.deepEqual(
    calls[0],
    {
      operationId: "refund:order_123",
      provider: "stripe-test",
      action: {
        type: "refund",
        order_id: "order_123",
        amount: 1000,
      },
    },
  );

  assert.equal(result.state, "CONFIRMED");
  assert.equal(result.receipt.id, "receipt_123");
});

test("Connect returns authoritative Once UNKNOWN unchanged", async () => {
  const once = {
    async execute() {
      return {
        state: "UNKNOWN",
      };
    },
  };

  const result =
    await executeConnectWithOnce({
      once,
      provider: "stripe-test",
      safety: protectedSafety,
      operationId: "refund:order_123",

      payload: {
        orderId: "order_123",
        amount: 1000,
      },

      action: {
        type: "refund",
        order_id: "order_123",
        amount: 1000,
      },

      bypass: async () => {
        throw new Error("bypass must not execute");
      },
    });

  assert.equal(result.state, "UNKNOWN");
});

test("Connect returns authoritative Once ABSENT unchanged", async () => {
  const once = {
    async execute() {
      return {
        state: "ABSENT",
      };
    },
  };

  const result =
    await executeConnectWithOnce({
      once,
      provider: "stripe-test",
      safety: protectedSafety,
      operationId: "refund:order_123",

      payload: {
        orderId: "order_123",
      },

      action: {
        type: "refund",
        order_id: "order_123",
      },

      bypass: async () => {
        throw new Error("bypass must not execute");
      },
    });

  assert.equal(result.state, "ABSENT");
});

test("safe bypass never calls Once.execute", async () => {
  let onceCalls = 0;

  const once = {
    async execute() {
      onceCalls += 1;
      throw new Error("Once.execute must not run");
    },
  };

  const result =
    await executeConnectWithOnce({
      once,
      provider: "stripe-test",

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

      action: {
        type: "read",
      },

      bypass: async () => "BYPASSED",
    });

  assert.equal(result, "BYPASSED");
  assert.equal(onceCalls, 0);
});

test("missing Once client executes nothing", async () => {
  let bypassCalls = 0;

  await assert.rejects(
    () =>
      executeConnectWithOnce({
        once: null,
        provider: "stripe-test",
        safety: protectedSafety,
        operationId: "refund:order_123",
        payload: {
          amount: 1000,
        },
        action: {
          type: "refund",
        },
        bypass: async () => {
          bypassCalls += 1;
        },
      }),

    (error) =>
      error instanceof ConnectKernelError &&
      error.code === "ONCE_CLIENT_REQUIRED",
  );

  assert.equal(bypassCalls, 0);
});

test("protected execution without provider fails before Once.execute", async () => {
  let onceCalls = 0;

  const once = {
    async execute() {
      onceCalls += 1;
    },
  };

  await assert.rejects(
    () =>
      executeConnectWithOnce({
        once,
        provider: "",
        safety: protectedSafety,
        operationId: "refund:order_123",
        payload: {
          amount: 1000,
        },
        action: {
          type: "refund",
        },
        bypass: async () => {
          throw new Error("must not bypass");
        },
      }),

    (error) =>
      error instanceof ConnectKernelError &&
      error.code === "PROVIDER_REQUIRED",
  );

  assert.equal(onceCalls, 0);
});

test("protected execution without action fails before Once.execute", async () => {
  let onceCalls = 0;

  const once = {
    async execute() {
      onceCalls += 1;
    },
  };

  await assert.rejects(
    () =>
      executeConnectWithOnce({
        once,
        provider: "stripe-test",
        safety: protectedSafety,
        operationId: "refund:order_123",
        payload: {
          amount: 1000,
        },
        action: null,
        bypass: async () => {
          throw new Error("must not bypass");
        },
      }),

    (error) =>
      error instanceof ConnectKernelError &&
      error.code === "ACTION_REQUIRED",
  );

  assert.equal(onceCalls, 0);
});

test("Once kernel errors propagate instead of falling back to bypass", async () => {
  let bypassCalls = 0;

  const kernelError =
    new Error("ambiguous kernel failure");

  const once = {
    async execute() {
      throw kernelError;
    },
  };

  await assert.rejects(
    () =>
      executeConnectWithOnce({
        once,
        provider: "stripe-test",
        safety: protectedSafety,
        operationId: "refund:order_123",

        payload: {
          amount: 1000,
        },

        action: {
          type: "refund",
          amount: 1000,
        },

        bypass: async () => {
          bypassCalls += 1;
          return "UNSAFE_FALLBACK";
        },
      }),

    (error) => error === kernelError,
  );

  assert.equal(bypassCalls, 0);
});

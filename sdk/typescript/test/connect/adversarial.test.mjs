import test from "node:test";
import assert from "node:assert/strict";

import {
  ConnectBindingError,
  bindConnectOperation,
  fingerprintConnectPayload,
} from "../../dist/connect/binding.js";

import {
  ConnectExecutionError,
  executeConnectOperation,
} from "../../dist/connect/execute.js";

import {
  ConnectKernelError,
  executeConnectWithOnce,
} from "../../dist/connect/kernel.js";

const protectedSafety = Object.freeze({
  changesExternalState: true,
  retryPossible: true,
  ambiguousOutcomePossible: true,
  duplicateUndesirable: true,
});

test("cyclic consequential payload fails closed before execution", async () => {
  let executions = 0;

  const payload = { amount: 1000 };
  payload.self = payload;

  await assert.rejects(
    () =>
      executeConnectOperation({
        safety: protectedSafety,
        operationId: "refund:cycle",
        payload,

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

test("undefined consequential value fails closed before execution", async () => {
  let executions = 0;

  await assert.rejects(
    () =>
      executeConnectOperation({
        safety: protectedSafety,
        operationId: "refund:undefined",
        payload: {
          amount: undefined,
        },

        bypass: async () => {
          executions += 1;
        },

        protect: async () => {
          executions += 1;
        },
      }),

    (error) =>
      error instanceof ConnectBindingError &&
      error.code === "UNSUPPORTED_PAYLOAD_VALUE",
  );

  assert.equal(executions, 0);
});

test("BigInt consequential value fails closed before execution", async () => {
  let executions = 0;

  await assert.rejects(
    () =>
      executeConnectOperation({
        safety: protectedSafety,
        operationId: "refund:bigint",
        payload: {
          amount: 1000n,
        },

        bypass: async () => {
          executions += 1;
        },

        protect: async () => {
          executions += 1;
        },
      }),

    (error) =>
      error instanceof ConnectBindingError &&
      error.code === "UNSUPPORTED_PAYLOAD_VALUE",
  );

  assert.equal(executions, 0);
});

test("symbol consequential value fails closed before execution", async () => {
  let executions = 0;

  await assert.rejects(
    () =>
      executeConnectOperation({
        safety: protectedSafety,
        operationId: "refund:symbol",
        payload: {
          amount: Symbol("1000"),
        },

        bypass: async () => {
          executions += 1;
        },

        protect: async () => {
          executions += 1;
        },
      }),

    (error) =>
      error instanceof ConnectBindingError &&
      error.code === "UNSUPPORTED_PAYLOAD_VALUE",
  );

  assert.equal(executions, 0);
});

test("non-plain object fails closed", () => {
  assert.throws(
    () =>
      fingerprintConnectPayload({
        when: new Date(),
      }),

    (error) =>
      error instanceof ConnectBindingError &&
      error.code === "UNSUPPORTED_PAYLOAD_VALUE",
  );
});

test("same operation identity cannot be rebound to changed amount", () => {
  const original = bindConnectOperation({
    operationId: "refund:order_123",
    payload: {
      amount: 1000,
      currency: "GBP",
    },
  });

  const changed = bindConnectOperation({
    operationId: "refund:order_123",
    payload: {
      amount: 1001,
      currency: "GBP",
    },
  });

  assert.notEqual(
    original.payloadFingerprint,
    changed.payloadFingerprint,
  );
});

test("protect handler exception never falls through to bypass", async () => {
  let bypassCalls = 0;
  let protectCalls = 0;

  const failure = new Error("protector exploded");

  await assert.rejects(
    () =>
      executeConnectOperation({
        safety: protectedSafety,
        operationId: "refund:protect-error",
        payload: {
          amount: 1000,
        },

        bypass: async () => {
          bypassCalls += 1;
          return "UNSAFE";
        },

        protect: async () => {
          protectCalls += 1;
          throw failure;
        },
      }),

    (error) => error === failure,
  );

  assert.equal(protectCalls, 1);
  assert.equal(bypassCalls, 0);
});

test("Once.execute exception never falls through to bypass", async () => {
  let onceCalls = 0;
  let bypassCalls = 0;

  const failure =
    new Error("ambiguous network outcome");

  const once = {
    async execute() {
      onceCalls += 1;
      throw failure;
    },
  };

  await assert.rejects(
    () =>
      executeConnectWithOnce({
        once,
        provider: "stripe-test",
        safety: protectedSafety,
        operationId: "refund:kernel-error",

        payload: {
          amount: 1000,
        },

        action: {
          type: "refund",
          amount: 1000,
        },

        bypass: async () => {
          bypassCalls += 1;
          return "UNSAFE";
        },
      }),

    (error) => error === failure,
  );

  assert.equal(onceCalls, 1);
  assert.equal(bypassCalls, 0);
});

test("concurrent protected calls never enter bypass", async () => {
  let protectCalls = 0;
  let bypassCalls = 0;

  const run = () =>
    executeConnectOperation({
      safety: protectedSafety,
      operationId: "refund:concurrent",

      payload: {
        amount: 1000,
      },

      bypass: async () => {
        bypassCalls += 1;
        return "UNSAFE";
      },

      protect: async () => {
        protectCalls += 1;
        await new Promise((resolve) =>
          setTimeout(resolve, 5),
        );
        return "PROTECTED";
      },
    });

  const results =
    await Promise.all([
      run(),
      run(),
      run(),
      run(),
    ]);

  assert.deepEqual(
    results,
    [
      "PROTECTED",
      "PROTECTED",
      "PROTECTED",
      "PROTECTED",
    ],
  );

  assert.equal(protectCalls, 4);
  assert.equal(bypassCalls, 0);
});

test("concurrent protected kernel calls all remain behind Once boundary", async () => {
  let onceCalls = 0;
  let bypassCalls = 0;

  const once = {
    async execute() {
      onceCalls += 1;

      await new Promise((resolve) =>
        setTimeout(resolve, 5),
      );

      return {
        state: "UNKNOWN",
      };
    },
  };

  const run = () =>
    executeConnectWithOnce({
      once,
      provider: "stripe-test",
      safety: protectedSafety,
      operationId: "refund:concurrent-kernel",

      payload: {
        amount: 1000,
      },

      action: {
        type: "refund",
        amount: 1000,
      },

      bypass: async () => {
        bypassCalls += 1;
        return "UNSAFE";
      },
    });

  const results =
    await Promise.all([
      run(),
      run(),
      run(),
      run(),
    ]);

  assert.equal(onceCalls, 4);
  assert.equal(bypassCalls, 0);

  for (const result of results) {
    assert.equal(result.state, "UNKNOWN");
  }
});

test("authoritative UNKNOWN is never converted into permission", async () => {
  let bypassCalls = 0;

  const once = {
    async execute() {
      return {
        state: "UNKNOWN",
        reason: "provider_truth_ambiguous",
      };
    },
  };

  const result =
    await executeConnectWithOnce({
      once,
      provider: "stripe-test",
      safety: protectedSafety,
      operationId: "refund:unknown",

      payload: {
        amount: 1000,
      },

      action: {
        type: "refund",
        amount: 1000,
      },

      bypass: async () => {
        bypassCalls += 1;
        return "UNSAFE";
      },
    });

  assert.deepEqual(result, {
    state: "UNKNOWN",
    reason: "provider_truth_ambiguous",
  });

  assert.equal(bypassCalls, 0);
});

test("operation identity whitespace cannot substitute for stable identity", async () => {
  let executions = 0;

  await assert.rejects(
    () =>
      executeConnectOperation({
        safety: protectedSafety,
        operationId: "   ",

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

test("malicious __proto__ JSON key is fingerprinted as data without prototype mutation", () => {
  const payload =
    JSON.parse(
      '{"amount":1000,"__proto__":{"polluted":true}}',
    );

  const before = {}.polluted;

  const fingerprint =
    fingerprintConnectPayload(payload);

  const after = {}.polluted;

  assert.equal(before, undefined);
  assert.equal(after, undefined);

  assert.match(
    fingerprint,
    /^once-connect-payload-v1:[a-f0-9]{64}$/,
  );
});

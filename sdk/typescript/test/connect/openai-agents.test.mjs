import test from "node:test";
import assert from "node:assert/strict";

import {
  executeOpenAIAgentsConnectTool,
} from "../../dist/connect/openai-agents.js";

const protectedSafety = {
  changesExternalState: true,
  retryPossible: true,
  ambiguousOutcomePossible: true,
  duplicateUndesirable: true,
};

test("OpenAI Agents protected tool call delegates exactly once through Connect", async () => {
  let onceCalls = 0;
  let bypassCalls = 0;

  const once = {
    async execute(input) {
      onceCalls += 1;

      assert.equal(
        input.operationId,
        "refund:order_123",
      );

      assert.equal(
        input.provider,
        "stripe-test",
      );

      assert.deepEqual(
        input.action,
        {
          type: "refund",
          order_id: "order_123",
        },
      );

      return {
        state: "CONFIRMED",
        operation_id: input.operationId,
      };
    },
  };

  const result =
    await executeOpenAIAgentsConnectTool({
      once,

      provider: "stripe-test",

      safety: protectedSafety,

      operationId:
        "refund:order_123",

      input: {
        orderId: "order_123",
      },

      action: {
        type: "refund",
        order_id: "order_123",
      },

      bypass: async () => {
        bypassCalls += 1;
        return "UNSAFE_BYPASS";
      },
    });

  assert.equal(onceCalls, 1);
  assert.equal(bypassCalls, 0);

  assert.deepEqual(
    result,
    {
      state: "CONFIRMED",
      operation_id: "refund:order_123",
    },
  );
});

test("OpenAI Agents safe tool call bypasses Once", async () => {
  let onceCalls = 0;
  let bypassCalls = 0;

  const once = {
    async execute() {
      onceCalls += 1;
      throw new Error(
        "safe bypass must not enter Once",
      );
    },
  };

  const result =
    await executeOpenAIAgentsConnectTool({
      once,

      provider: "unused",

      safety: {
        changesExternalState: false,
        retryPossible: true,
        ambiguousOutcomePossible: true,
        duplicateUndesirable: true,
      },

      operationId:
        "read:order_123",

      input: {
        orderId: "order_123",
      },

      action: {
        type: "read",
      },

      bypass: async () => {
        bypassCalls += 1;
        return "BYPASSED";
      },
    });

  assert.equal(result, "BYPASSED");
  assert.equal(bypassCalls, 1);
  assert.equal(onceCalls, 0);
});

test("OpenAI Agents adapter preserves authoritative Once UNKNOWN", async () => {
  const authoritative = {
    state: "UNKNOWN",
    operation_id: "refund:order_123",
  };

  const once = {
    async execute() {
      return authoritative;
    },
  };

  const result =
    await executeOpenAIAgentsConnectTool({
      once,

      provider: "stripe-test",

      safety: protectedSafety,

      operationId:
        "refund:order_123",

      input: {
        orderId: "order_123",
      },

      action: {
        type: "refund",
        order_id: "order_123",
      },

      bypass: async () => {
        throw new Error(
          "UNKNOWN must never fall back to bypass",
        );
      },
    });

  assert.equal(
    result,
    authoritative,
  );
});

test("OpenAI Agents adapter preserves authoritative Once ABSENT", async () => {
  const authoritative = {
    state: "ABSENT",
    operation_id: "refund:order_123",
  };

  const once = {
    async execute() {
      return authoritative;
    },
  };

  const result =
    await executeOpenAIAgentsConnectTool({
      once,

      provider: "stripe-test",

      safety: protectedSafety,

      operationId:
        "refund:order_123",

      input: {
        orderId: "order_123",
      },

      action: {
        type: "refund",
        order_id: "order_123",
      },

      bypass: async () => {
        throw new Error(
          "ABSENT must never fall back to bypass",
        );
      },
    });

  assert.equal(
    result,
    authoritative,
  );
});

test("OpenAI Agents adapter rejects malformed tool input before execution", async () => {
  let onceCalls = 0;
  let bypassCalls = 0;

  const once = {
    async execute() {
      onceCalls += 1;
    },
  };

  await assert.rejects(
    () =>
      executeOpenAIAgentsConnectTool({
        once,

        provider: "stripe-test",

        safety: protectedSafety,

        operationId:
          "refund:order_123",

        input: null,

        action: {
          type: "refund",
        },

        bypass: async () => {
          bypassCalls += 1;
        },
      }),
  );

  assert.equal(onceCalls, 0);
  assert.equal(bypassCalls, 0);
});

test("OpenAI Agents adapter propagates Once failure without unsafe fallback", async () => {
  let bypassCalls = 0;

  const kernelError =
    new Error(
      "ambiguous provider outcome",
    );

  const once = {
    async execute() {
      throw kernelError;
    },
  };

  await assert.rejects(
    () =>
      executeOpenAIAgentsConnectTool({
        once,

        provider: "stripe-test",

        safety: protectedSafety,

        operationId:
          "refund:order_123",

        input: {
          orderId: "order_123",
        },

        action: {
          type: "refund",
        },

        bypass: async () => {
          bypassCalls += 1;
          return "UNSAFE_FALLBACK";
        },
      }),

    (error) =>
      error === kernelError,
  );

  assert.equal(bypassCalls, 0);
});

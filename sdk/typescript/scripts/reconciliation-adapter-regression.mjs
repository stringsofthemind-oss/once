import assert from "node:assert/strict";

import {
  createHttpStatusReconciliationAdapter,
  createProviderReconciliationAdapter,
  evaluateProviderLookup,
  reconciliationEvidenceToLocalObservation,
} from "../dist/reconciliation/index.js";

const context = {
  id: "create-order:123",
  payload: {
    tool: "orders",
    effect: {
      amount: 4200,
      currency: "GBP",
      customer: "cus_123",
    },
  },
};

const receipt = {
  provider_id: "ord_123",
  status: "created",
};

const matchingBody = {
  operation_id: context.id,
  payload: {
    effect: {
      currency: "GBP",
      customer: "cus_123",
      amount: 4200,
    },
    tool: "orders",
  },
  result: receipt,
};

const decodeFound = ({ body }) => ({
  operationId: body.operation_id,
  payload: body.payload,
  result: body.result,
});

const calls = [];
const confirmedAdapter =
  createHttpStatusReconciliationAdapter({
    source: "orders-status-api",
    url: ({ id }) =>
      `https://provider.example.test/operations/${encodeURIComponent(id)}`,
    headers: {
      authorization: "Bearer test-only",
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify(matchingBody),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
    decodeFound,
  });

const confirmed =
  await confirmedAdapter.inspect(context);

assert.equal(confirmed.state, "CONFIRMED");
assert.equal(confirmed.source, "orders-status-api");
assert.deepEqual(confirmed.result, receipt);
assert.equal(confirmed.operationId, context.id);
assert.match(
  confirmed.effectFingerprint,
  /^once-connect-payload-v1:[0-9a-f]{64}$/,
);
assert.equal(calls.length, 1);
assert.equal(calls[0].init.method, "GET");
assert.equal(calls[0].init.redirect, "error");
assert.equal(
  calls[0].init.headers.authorization,
  "Bearer test-only",
);

assert.deepEqual(
  await confirmedAdapter.reconcile(context),
  {
    state: "CONFIRMED",
    result: receipt,
  },
);

const operationMismatch =
  createHttpStatusReconciliationAdapter({
    url: () => "https://provider.example.test/operations/wrong",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ...matchingBody,
          operation_id: "create-order:other",
        }),
        { status: 200 },
      ),
    decodeFound,
  });

const wrongOperation =
  await operationMismatch.inspect(context);

assert.equal(wrongOperation.state, "MISMATCH");
assert.equal(
  wrongOperation.reason,
  "OPERATION_ID_MISMATCH",
);

const effectMismatch =
  createHttpStatusReconciliationAdapter({
    url: () => "https://provider.example.test/operations/123",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ...matchingBody,
          payload: {
            tool: "orders",
            effect: {
              amount: 4300,
              currency: "GBP",
              customer: "cus_123",
            },
          },
        }),
        { status: 200 },
      ),
    decodeFound,
  });

const wrongEffect =
  await effectMismatch.inspect(context);

assert.equal(wrongEffect.state, "MISMATCH");
assert.equal(
  wrongEffect.reason,
  "EFFECT_PAYLOAD_MISMATCH",
);

const authoritativeAbsent =
  createHttpStatusReconciliationAdapter({
    source: "authoritative-order-status",
    url: () => "https://provider.example.test/operations/123",
    authoritativeAbsenceStatuses: [404],
    fetchImpl: async () =>
      new Response(null, { status: 404 }),
    decodeFound,
  });

const absentEvidence =
  await authoritativeAbsent.inspect(context);

assert.equal(
  absentEvidence.state,
  "ABSENT_PROVEN",
);
assert.deepEqual(
  await authoritativeAbsent.reconcile(context),
  { state: "ABSENT" },
);

const ordinary404 =
  createHttpStatusReconciliationAdapter({
    url: () => "https://provider.example.test/operations/123",
    fetchImpl: async () =>
      new Response(null, { status: 404 }),
    decodeFound,
  });

assert.equal(
  (await ordinary404.inspect(context)).state,
  "UNKNOWN",
  "an ordinary 404 must not silently become authoritative absence",
);

const serverError =
  createHttpStatusReconciliationAdapter({
    url: () => "https://provider.example.test/operations/123",
    fetchImpl: async () =>
      new Response("unavailable", { status: 503 }),
    decodeFound,
  });

assert.equal(
  (await serverError.inspect(context)).state,
  "UNKNOWN",
);

const networkFailure =
  createHttpStatusReconciliationAdapter({
    url: () => "https://provider.example.test/operations/123",
    fetchImpl: async () => {
      throw new Error("synthetic network failure");
    },
    decodeFound,
  });

const failedLookup =
  await networkFailure.inspect(context);

assert.equal(failedLookup.state, "UNKNOWN");
assert.match(
  failedLookup.detail,
  /synthetic network failure/,
);

const generic =
  createProviderReconciliationAdapter({
    source: "generic-provider",
    lookup: async () => ({
      kind: "FOUND",
      operationId: context.id,
      payload: context.payload,
      result: receipt,
    }),
  });

assert.equal(
  (await generic.inspect(context)).state,
  "CONFIRMED",
);

const evaluatedAbsent =
  evaluateProviderLookup(
    context,
    {
      kind: "ABSENT_PROVEN",
      source: "unit-provider",
      detail: "provider guarantees absence",
    },
  );

assert.equal(
  evaluatedAbsent.state,
  "ABSENT_PROVEN",
);
assert.deepEqual(
  reconciliationEvidenceToLocalObservation(
    evaluatedAbsent,
  ),
  { state: "ABSENT" },
);

const mismatchLocal =
  reconciliationEvidenceToLocalObservation(
    wrongEffect,
  );

assert.deepEqual(
  mismatchLocal,
  { state: "UNKNOWN" },
  "mismatch evidence must never become retry eligibility in local mode",
);

assert.throws(
  () =>
    createHttpStatusReconciliationAdapter({
      url: () => "https://provider.example.test/operations/123",
      authoritativeAbsenceStatuses: [500],
      fetchImpl: async () =>
        new Response(null, { status: 500 }),
      decodeFound,
    }),
  /Only explicit 404 or 410/,
);

console.log("reconciliation adapter regression: PASS");

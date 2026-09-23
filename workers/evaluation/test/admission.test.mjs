import test from "node:test";
import assert from "node:assert/strict";
import { EvaluationAdmission } from "../src/admission.js";

const EVALUATION_A = "123e4567-e89b-42d3-a456-426614174000";
const EVALUATION_B = "223e4567-e89b-42d3-a456-426614174001";
const EVALUATION_C = "323e4567-e89b-42d3-a456-426614174002";
const CLIENT_A = "a".repeat(64);
const CLIENT_B = "b".repeat(64);
const CLIENT_C = "c".repeat(64);

function makeContext() {
  const values = new Map();

  const txn = {
    async get(key) {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async put(key, value) {
      values.set(key, structuredClone(value));
    },
  };

  return {
    storage: {
      ...txn,
      async transaction(callback) {
        return callback(txn);
      },
    },
  };
}

function makeAdmission({ maxPerClient = 3, globalMax = 100 } = {}) {
  return new EvaluationAdmission(
    makeContext(),
    {
      EVALUATION_MAX_PER_CLIENT_24H: String(maxPerClient),
      EVALUATION_GLOBAL_MAX_24H: String(globalMax),
    },
  );
}

async function admit(instance, evaluationId, clientKey) {
  return instance.fetch(
    new Request("https://evaluation.internal/admit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evaluation_id: evaluationId,
        client_key: clientKey,
      }),
    }),
  );
}

test("same evaluation retry is free while a new evaluation from the same client is rate limited", async () => {
  const admission = makeAdmission({ maxPerClient: 1, globalMax: 10 });

  const first = await admit(admission, EVALUATION_A, CLIENT_A);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).retry, false);

  const retry = await admit(admission, EVALUATION_A, CLIENT_A);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).retry, true);

  const secondEvaluation = await admit(admission, EVALUATION_B, CLIENT_A);
  assert.equal(secondEvaluation.status, 429);
  assert.equal((await secondEvaluation.json()).error, "evaluation_rate_limited");
  assert.ok(Number(secondEvaluation.headers.get("retry-after")) >= 1);
});

test("evaluation identity is bound to the first admitted client", async () => {
  const admission = makeAdmission();

  const first = await admit(admission, EVALUATION_A, CLIENT_A);
  assert.equal(first.status, 200);

  const mismatch = await admit(admission, EVALUATION_A, CLIENT_B);
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error, "evaluation_identity_mismatch");
});

test("global capacity blocks new evaluations across otherwise distinct clients", async () => {
  const admission = makeAdmission({ maxPerClient: 10, globalMax: 2 });

  assert.equal((await admit(admission, EVALUATION_A, CLIENT_A)).status, 200);
  assert.equal((await admit(admission, EVALUATION_B, CLIENT_B)).status, 200);

  const overCapacity = await admit(admission, EVALUATION_C, CLIENT_C);
  assert.equal(overCapacity.status, 429);
  assert.equal((await overCapacity.json()).error, "evaluation_capacity_reached");
  assert.ok(Number(overCapacity.headers.get("retry-after")) >= 1);
});

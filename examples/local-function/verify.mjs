import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { protectLocal } from "@once-agent/sdk";

// This fake provider writes to a separate durable effect log, not the Once
// ledger. For a real integration, count effects in the provider's sandbox.
const session = randomUUID();
const effectsPath = path.resolve(`effects-${session}.jsonl`);
const createOrder = protectLocal(
  async ({ orderId, amountCents }) => {
    appendFileSync(effectsPath, JSON.stringify({ orderId, amountCents }) + "\n");
    return { orderId, amountCents };
  },
  {
    id: ({ orderId }) => `create-order:${orderId}`,
    payload: ({ orderId, amountCents }) => ({ orderId, amountCents }),
  },
);

const a = { orderId: `A-${session}`, amountCents: 100 };
const b = { orderId: `B-${session}`, amountCents: 100 };
assert.deepEqual(await createOrder(a), await createOrder(a));
await createOrder(b);
await assert.rejects(
  createOrder({ orderId: a.orderId, amountCents: 125 }),
  { code: "CONFLICT" },
);
assert.equal(readFileSync(effectsPath, "utf8").trim().split("\n").length, 2);
console.log("Verified: A/100 + retry, B/100, A/125 conflict => 2 effects");

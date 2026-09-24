import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AmbiguousOrderProvider
} from "../src/provider.mjs";

import {
  createOrderTool
} from "../src/create-order.mjs";

const dir = fs.mkdtempSync(
  path.join(os.tmpdir(), "adoption-v1-baseline-")
);

const statePath = path.join(dir, "provider.json");

const provider = new AmbiguousOrderProvider(statePath);

const createOrder = createOrderTool({ provider });

const input = {
  operationId: "order:customer-42:checkout-9001",
  sku: "SKU-RED-1",
  quantity: 1
};

provider.armAmbiguousFailure(input.operationId);

await assert.rejects(
  () => createOrder(input),
  /NETWORK_DROPPED_AFTER_PROVIDER_COMMIT/
);

// Runtime retries same logical operation.
await createOrder(input);

// Starting implementation is deliberately unsafe.
// Two provider orders prove the duplicate.
assert.equal(
  provider.getOrders().length,
  2,
  "Baseline should demonstrate duplicate external execution"
);

console.log(
  "BASELINE_UNSAFE_DUPLICATE_REPRODUCED"
);

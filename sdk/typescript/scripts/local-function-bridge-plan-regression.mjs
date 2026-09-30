import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  LOCAL_FUNCTION_BRIDGE_PLAN_FILE,
  planLocalFunctionBridge,
  writeLocalFunctionBridgePlan,
} from "../dist/local-function-bridge.js";

const root = process.cwd();
const temp = path.join(root, ".local-function-bridge-plan-regression-temp");

await rm(temp, { recursive: true, force: true });
await mkdir(temp, { recursive: true });

try {
  const source = [
    "export const provider = {",
    "  async createOrder({ orderId, amountCents }) {",
    "    return { orderId, amountCents, status: \"created\" };",
    "  }",
    "};",
    "",
    "export const createOrder = async ({ orderId, amountCents }) =>",
    "  provider.createOrder({ orderId, amountCents });",
    "",
  ].join("\n");

  const sourcePath = path.join(temp, "orders.mjs");
  await writeFile(sourcePath, source, "utf8");

  const selection = {
    target: "orders.mjs:createOrder",
    idPrefix: "create-order",
    idField: "orderId",
  };

  const plan = await planLocalFunctionBridge(temp, selection);

  assert.equal(plan.schema_version, 1);
  assert.equal(plan.kind, "local_function_v1");
  assert.equal(plan.source_modified, false);
  assert.equal(plan.target.file, "orders.mjs");
  assert.equal(plan.target.function_name, "createOrder");
  assert.equal(plan.target.category, "BOOKING");
  assert.equal(plan.target.transformer_id, "mjs_local_function_v1");
  assert.equal(plan.target.patch_plan_id, "mjs_local_function_patch_v1");
  assert.equal(plan.target.id_prefix, "create-order");
  assert.equal(plan.target.id_field, "orderId");
  assert.deepEqual(plan.target.input_fields, ["orderId", "amountCents"]);
  assert.equal(plan.target.binding_strategy, "esm_import_protect_local_v1");
  assert.equal(await readFile(sourcePath, "utf8"), source, "planning must not modify source");

  const written = await writeLocalFunctionBridgePlan(temp, selection);
  assert.deepEqual(
    {
      ...written,
      generated_at: "<time>",
    },
    {
      ...plan,
      generated_at: "<time>",
    },
    "written plan must preserve the reviewed contract apart from generation time",
  );

  const planPath = path.join(temp, ".once", LOCAL_FUNCTION_BRIDGE_PLAN_FILE);
  const diskPlan = JSON.parse(await readFile(planPath, "utf8"));
  assert.equal(diskPlan.target.source_sha256, plan.target.source_sha256);
  assert.equal(diskPlan.target.proposed_source_sha256, plan.target.proposed_source_sha256);
  assert.equal(await readFile(sourcePath, "utf8"), source, "writing plan must remain read-only");

  await assert.rejects(
    planLocalFunctionBridge(temp, {
      ...selection,
      idField: "notPresent",
    }),
    /identity field/i,
  );

  await assert.rejects(
    planLocalFunctionBridge(temp, {
      ...selection,
      idPrefix: "",
    }),
    /identity prefix/i,
  );

  await assert.rejects(
    planLocalFunctionBridge(temp, {
      ...selection,
      target: "orders.mjs:missingFunction",
    }),
    /pinned BOOKING\/order bridge contract/i,
  );

  await assert.rejects(
    planLocalFunctionBridge(temp, {
      ...selection,
      target: "../outside.mjs:createOrder",
    }),
    /inside the selected project|project-relative/i,
  );

  const blockSource = [
    "export const createOrder = async ({ orderId, amountCents }) => {",
    "  return provider.createOrder({ orderId, amountCents });",
    "};",
    "",
  ].join("\n");
  await writeFile(path.join(temp, "block.mjs"), blockSource, "utf8");

  await assert.rejects(
    planLocalFunctionBridge(temp, {
      target: "block.mjs:createOrder",
      idPrefix: "create-order",
      idField: "orderId",
    }),
    /expression body|pinned BOOKING\/order bridge contract/i,
  );

  console.log("local-function bridge planning regression: PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}

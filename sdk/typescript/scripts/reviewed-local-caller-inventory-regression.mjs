import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { inventoryReviewedLocalCallers } from "../dist/reviewed-local-caller-inventory.js";
import { buildReviewedLocalProtectionPreview } from "../dist/reviewed-local-preview.js";
import { writeReviewedLocalSemanticsPlan } from "../dist/reviewed-local-semantics.js";

const root = process.cwd();
const temp = path.join(root, ".reviewed-local-caller-inventory-temp");
const onceDir = path.join(temp, ".once");
const targetPath = path.join(temp, "booking.mjs");
const callerPath = path.join(temp, "checkout.mjs");

const targetSource = [
  "export async function createBooking(input) {",
  "  return { bookingId: input.intentId, guest: input.guest };",
  "}",
  "",
].join("\n");

const callerSource = [
  "import { createBooking } from './booking.mjs';",
  "export async function checkout(input) {",
  "  return await createBooking(input);",
  "}",
  "",
].join("\n");

await rm(temp, { recursive: true, force: true });
await mkdir(onceDir, { recursive: true });
await writeFile(targetPath, targetSource, "utf8");
await writeFile(callerPath, callerSource, "utf8");
await writeFile(
  path.join(onceDir, "protect-plan.json"),
  JSON.stringify({
    candidates: [{
      file: "booking.mjs",
      function_name: "createBooking",
      confidence: "LOW",
      category: "FILE_WRITE",
      automation_status: "MANUAL_REVIEW",
      auto_apply_eligible: false,
    }],
  }, null, 2) + "\n",
  "utf8",
);

try {
  await writeReviewedLocalSemanticsPlan(temp, {
    target: "booking.mjs:createBooking",
    idPrefix: "create-booking",
    idPath: "intentId",
    payloadPaths: ["intentId", "guest"],
    confirmReviewed: true,
  });

  const preview = await buildReviewedLocalProtectionPreview(temp);
  const companionPath = path.join(temp, preview.output.file);
  await mkdir(path.dirname(companionPath), { recursive: true });
  await writeFile(companionPath, preview.output.module_source, "utf8");

  const inventory = await inventoryReviewedLocalCallers(temp);
  assert.equal(inventory.kind, "reviewed_local_caller_inventory_v1");
  assert.equal(inventory.status, "READY_FOR_ROUTING_REVIEW");
  assert.equal(inventory.source_modified, false);
  assert.equal(inventory.generated_file_modified, false);
  assert.equal(inventory.application_wired, false);
  assert.equal(inventory.companion.verified_materialized, true);
  assert.equal(inventory.callers.length, 1);
  assert.equal(inventory.callers[0].file, "checkout.mjs");
  assert.equal(inventory.callers[0].import.imported_name, "createBooking");
  assert.equal(inventory.callers[0].call_sites.length, 1);
  assert.equal(inventory.blockers.length, 0);
  assert.deepEqual(await inventoryReviewedLocalCallers(temp), inventory);
  assert.equal(await readFile(targetPath, "utf8"), targetSource);
  assert.equal(await readFile(callerPath, "utf8"), callerSource);

  const reexportPath = path.join(temp, "reexport.mjs");
  await writeFile(
    reexportPath,
    "export { createBooking } from './booking.mjs';\n",
    "utf8",
  );
  const blocked = await inventoryReviewedLocalCallers(temp);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(
    blocked.blockers.some(item => item.kind === "TARGET_REEXPORT"),
    true,
  );
  await rm(reexportPath, { force: true });

  await writeFile(companionPath, preview.output.module_source + "// changed\n", "utf8");
  await assert.rejects(
    () => inventoryReviewedLocalCallers(temp),
    /differs from the reviewed deterministic preview/,
  );

  console.log("Reviewed local caller inventory regression: PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}

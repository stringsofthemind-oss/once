import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildReviewedLocalProtectionPreview } from "../dist/reviewed-local-preview.js";
import { buildReviewedLocalRoutingPreview } from "../dist/reviewed-local-routing-preview.js";
import { writeReviewedLocalSemanticsPlan } from "../dist/reviewed-local-semantics.js";

const root = process.cwd();
const temp = path.join(root, ".reviewed-local-routing-preview-temp");
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
  "import { createBooking as submitBooking } from './booking.mjs';",
  "export async function checkout(input) {",
  "  return await submitBooking(input);",
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

  const companion = await buildReviewedLocalProtectionPreview(temp);
  const companionPath = path.join(temp, companion.output.file);
  await mkdir(path.dirname(companionPath), { recursive: true });
  await writeFile(companionPath, companion.output.module_source, "utf8");

  const preview = await buildReviewedLocalRoutingPreview(temp);
  assert.equal(preview.kind, "reviewed_local_routing_preview_v1");
  assert.equal(preview.status, "PATCHABLE_PREVIEW");
  assert.equal(preview.source_modified, false);
  assert.equal(preview.generated_file_modified, false);
  assert.equal(preview.application_wired, false);
  assert.match(preview.inventory_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(preview.routes.length, 1);
  assert.equal(preview.blockers.length, 0);

  const route = preview.routes[0];
  assert.equal(route.file, "checkout.mjs");
  assert.equal(route.imported_name, "createBooking");
  assert.equal(route.local_name, "submitBooking");
  assert.equal(route.direct_call_count, 1);
  assert.equal(route.replacement.before, "'./booking.mjs'");
  assert.match(
    route.replacement.after,
    /^'\.\/\.once\/generated\/createBooking-[0-9a-f]{12}\.once\.mjs'$/,
  );
  assert.match(route.source_sha256, /^[0-9a-f]{64}$/);
  assert.match(route.result_source_sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(route.source_sha256, route.result_source_sha256);
  assert.deepEqual(await buildReviewedLocalRoutingPreview(temp), preview);
  assert.equal(await readFile(targetPath, "utf8"), targetSource);
  assert.equal(await readFile(callerPath, "utf8"), callerSource);

  const mixedPath = path.join(temp, "mixed.mjs");
  const mixedSource = [
    "import { createBooking, helper } from './booking.mjs';",
    "export async function mixed(input) { return createBooking(input); }",
    "",
  ].join("\n");
  await writeFile(mixedPath, mixedSource, "utf8");
  const mixedPreview = await buildReviewedLocalRoutingPreview(temp);
  assert.equal(mixedPreview.status, "BLOCKED");
  assert.equal(mixedPreview.routes.length, 0);
  assert.equal(
    mixedPreview.blockers.some(item => item.kind === "MIXED_IMPORT_BINDINGS"),
    true,
  );
  assert.equal(await readFile(mixedPath, "utf8"), mixedSource);
  await rm(mixedPath, { force: true });

  const reexportPath = path.join(temp, "reexport.mjs");
  await writeFile(
    reexportPath,
    "export { createBooking } from './booking.mjs';\n",
    "utf8",
  );
  const blockedByInventory = await buildReviewedLocalRoutingPreview(temp);
  assert.equal(blockedByInventory.status, "BLOCKED");
  assert.equal(blockedByInventory.routes.length, 0);
  assert.equal(
    blockedByInventory.blockers.some(
      item => item.kind === "INVENTORY_BLOCKED" && item.reason.includes("TARGET_REEXPORT"),
    ),
    true,
  );
  await rm(reexportPath, { force: true });

  await rm(callerPath, { force: true });
  const noCallers = await buildReviewedLocalRoutingPreview(temp);
  assert.equal(noCallers.status, "NO_DIRECT_CALLERS");
  assert.equal(noCallers.routes.length, 0);
  assert.equal(noCallers.blockers.length, 0);

  console.log("Reviewed local routing preview regression: PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}

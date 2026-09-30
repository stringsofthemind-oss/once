import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildReviewedLocalProtectionPreview } from "../dist/reviewed-local-preview.js";
import { buildReviewedLocalRoutingPreview } from "../dist/reviewed-local-routing-preview.js";
import {
  REVIEWED_LOCAL_ROUTING_REVIEW_FILE,
  buildReviewedLocalRoutingReview,
  loadReviewedLocalRoutingReview,
  writeReviewedLocalRoutingReview,
} from "../dist/reviewed-local-routing-review.js";
import { writeReviewedLocalSemanticsPlan } from "../dist/reviewed-local-semantics.js";

const root = process.cwd();
const temp = path.join(root, ".reviewed-local-routing-review-temp");
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
  assert.equal(preview.status, "PATCHABLE_PREVIEW");
  assert.equal(preview.routes.length, 1);

  await assert.rejects(
    () => buildReviewedLocalRoutingReview(temp, false),
    /explicit developer confirmation/,
  );
  assert.equal(
    await readFile(callerPath, "utf8"),
    callerSource,
  );

  const built = await buildReviewedLocalRoutingReview(temp, true);
  assert.equal(built.kind, "reviewed_local_routing_review_v1");
  assert.equal(built.source_modified, false);
  assert.equal(built.generated_file_modified, false);
  assert.equal(built.application_wired, false);
  assert.equal(built.review.developer_confirmed, true);
  assert.equal(built.review.inventory_fingerprint, preview.inventory_fingerprint);
  assert.deepEqual(built.review.target, preview.target);
  assert.deepEqual(built.review.companion, preview.companion);
  assert.deepEqual(built.review.routes, preview.routes);
  assert.match(built.review.routing_review_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(await readFile(callerPath, "utf8"), callerSource);

  const written = await writeReviewedLocalRoutingReview(temp, true);
  const reviewPath = path.join(onceDir, REVIEWED_LOCAL_ROUTING_REVIEW_FILE);
  const onDisk = JSON.parse(await readFile(reviewPath, "utf8"));
  assert.deepEqual(onDisk, written);
  assert.equal(onDisk.review.routing_review_fingerprint, built.review.routing_review_fingerprint);
  assert.equal(await readFile(targetPath, "utf8"), targetSource);
  assert.equal(await readFile(callerPath, "utf8"), callerSource);
  assert.equal(await readFile(companionPath, "utf8"), companion.output.module_source);

  const loaded = await loadReviewedLocalRoutingReview(temp);
  assert.deepEqual(loaded, written);

  await assert.rejects(
    () => writeReviewedLocalRoutingReview(temp, true),
    /already exists/,
  );

  const tampered = structuredClone(onDisk);
  tampered.review.routes[0].replacement.after = "'./tampered.mjs'";
  await writeFile(reviewPath, JSON.stringify(tampered, null, 2) + "\n", "utf8");
  await assert.rejects(
    () => loadReviewedLocalRoutingReview(temp),
    /malformed|fingerprint/,
  );

  console.log("Reviewed local routing review regression: PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}

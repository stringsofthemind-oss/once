import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  REVIEWED_LOCAL_SEMANTICS_FILE,
  planReviewedLocalSemantics,
  validateReviewedLocalSemanticsPlan,
  writeReviewedLocalSemanticsPlan,
} from "../dist/reviewed-local-semantics.js";

const root = process.cwd();
const temp = path.join(root, ".reviewed-local-semantics-temp");
const onceDir = path.join(temp, ".once");
const reviewPath = path.join(onceDir, REVIEWED_LOCAL_SEMANTICS_FILE);
const manualPath = path.join(temp, "booking.mjs");
const destructuredPath = path.join(temp, "http-order.mjs");

const manualSource = [
  "import { appendFile } from \"node:fs/promises\";",
  "",
  "export async function createBooking(input) {",
  "  const receipt = { bookingId: input.intentId, guest: input.guest, room: input.room, date: input.date };",
  "  await appendFile(\"bookings.jsonl\", JSON.stringify(receipt) + \"\\n\");",
  "  return receipt;",
  "}",
  "",
].join("\n");

const destructuredSource = [
  "export async function createHttpOrder({ checkoutId, sku, quantity }) {",
  "  const response = await fetch(\"https://example.invalid/orders\", {",
  "    method: \"POST\",",
  "    headers: { \"Content-Type\": \"application/json\" },",
  "    body: JSON.stringify({ checkoutId, sku, quantity })",
  "  });",
  "  return response.json();",
  "}",
  "",
].join("\n");

const protectPlan = {
  candidates: [
    {
      file: "booking.mjs",
      function_name: "createBooking",
      confidence: "LOW",
      category: "FILE_WRITE",
      automation_status: "MANUAL_REVIEW",
      auto_apply_eligible: false,
    },
    {
      file: "http-order.mjs",
      function_name: "createHttpOrder",
      confidence: "MEDIUM",
      category: "HTTP_WRITE",
      automation_status: "PROVIDER_MAPPING_REQUIRED",
      auto_apply_eligible: false,
    },
  ],
};

await rm(temp, { recursive: true, force: true });
await mkdir(onceDir, { recursive: true });
await writeFile(manualPath, manualSource, "utf8");
await writeFile(destructuredPath, destructuredSource, "utf8");
await writeFile(
  path.join(onceDir, "protect-plan.json"),
  JSON.stringify(protectPlan, null, 2) + "\n",
  "utf8",
);

try {
  await assert.rejects(
    () =>
      planReviewedLocalSemantics(temp, {
        target: "booking.mjs:createBooking",
        idPrefix: "create-booking",
        idPath: "intentId",
        payloadPaths: ["intentId", "guest", "room", "date"],
        confirmReviewed: false,
      }),
    /explicit developer confirmation/,
  );

  await assert.rejects(
    () =>
      planReviewedLocalSemantics(temp, {
        target: "booking.mjs:createBooking",
        idPrefix: "create-booking",
        idPath: "intentId",
        payloadPaths: ["guest", "room", "date"],
        confirmReviewed: true,
      }),
    /must include the selected identity path/,
  );

  await assert.rejects(
    () =>
      planReviewedLocalSemantics(temp, {
        target: "booking.mjs:createBooking",
        idPrefix: "create-booking",
        idPath: "intentId",
        payloadPaths: ["intentId", "guest", "guest"],
        confirmReviewed: true,
      }),
    /payload paths must be unique/,
  );

  await assert.rejects(
    () =>
      planReviewedLocalSemantics(temp, {
        target: "booking.mjs:createBooking",
        idPrefix: "create-booking",
        idPath: "input[0]",
        payloadPaths: ["input[0]"],
        confirmReviewed: true,
      }),
    /simple dot-separated property path/,
  );

  const manualPlan = await writeReviewedLocalSemanticsPlan(temp, {
    target: "booking.mjs:createBooking",
    idPrefix: "create-booking",
    idPath: "intentId",
    payloadPaths: ["intentId", "guest", "room", "date"],
    confirmReviewed: true,
  });

  assert.equal(manualPlan.kind, "reviewed_local_semantics_v1");
  assert.equal(manualPlan.source_modified, false);
  assert.equal(manualPlan.runnable, false);
  assert.equal(manualPlan.target.file, "booking.mjs");
  assert.equal(manualPlan.target.function_name, "createBooking");
  assert.equal(manualPlan.target.candidate.category, "FILE_WRITE");
  assert.equal(manualPlan.target.candidate.automation_status, "MANUAL_REVIEW");
  assert.equal(manualPlan.target.candidate.auto_apply_eligible, false);
  assert.equal(manualPlan.target.source_observations.parameter_shape, "identifier");
  assert.deepEqual(manualPlan.target.source_observations.top_level_fields, []);
  assert.equal(manualPlan.review.developer_confirmed, true);
  assert.equal(manualPlan.review.identity.prefix, "create-booking");
  assert.equal(manualPlan.review.identity.path, "intentId");
  assert.deepEqual(manualPlan.review.payload.paths, [
    "intentId",
    "guest",
    "room",
    "date",
  ]);
  assert.equal(await readFile(manualPath, "utf8"), manualSource);
  assert.equal(await readFile(destructuredPath, "utf8"), destructuredSource);

  const validatedManual = await validateReviewedLocalSemanticsPlan(temp);
  assert.deepEqual(validatedManual, manualPlan);

  await assert.rejects(
    () =>
      writeReviewedLocalSemanticsPlan(temp, {
        target: "booking.mjs:createBooking",
        idPrefix: "create-booking",
        idPath: "intentId",
        payloadPaths: ["intentId", "guest", "room", "date"],
        confirmReviewed: true,
      }),
    /EEXIST/,
  );

  await writeFile(manualPath, manualSource + "// changed after review\n", "utf8");
  await assert.rejects(
    () => validateReviewedLocalSemanticsPlan(temp),
    /Source changed after reviewed local semantics were recorded/,
  );
  await writeFile(manualPath, manualSource, "utf8");

  await rm(reviewPath, { force: true });
  const destructuredPlan = await writeReviewedLocalSemanticsPlan(temp, {
    target: "http-order.mjs:createHttpOrder",
    idPrefix: "create-http-order",
    idPath: "checkoutId",
    payloadPaths: ["checkoutId", "sku", "quantity"],
    confirmReviewed: true,
  });
  assert.equal(
    destructuredPlan.target.source_observations.parameter_shape,
    "object_destructure",
  );
  assert.deepEqual(destructuredPlan.target.source_observations.top_level_fields, [
    "checkoutId",
    "sku",
    "quantity",
  ]);
  assert.deepEqual(destructuredPlan.review.payload.paths, [
    "checkoutId",
    "sku",
    "quantity",
  ]);
  assert.equal(await readFile(destructuredPath, "utf8"), destructuredSource);
  await validateReviewedLocalSemanticsPlan(temp);

  const modifiedProtectPlan = structuredClone(protectPlan);
  modifiedProtectPlan.candidates[1].automation_status = "ADAPTER_REQUIRED";
  await writeFile(
    path.join(onceDir, "protect-plan.json"),
    JSON.stringify(modifiedProtectPlan, null, 2) + "\n",
    "utf8",
  );
  await assert.rejects(
    () => validateReviewedLocalSemanticsPlan(temp),
    /candidate evidence changed after semantic review/,
  );

  await writeFile(reviewPath, "{}\n", "utf8");
  await assert.rejects(
    () => validateReviewedLocalSemanticsPlan(temp),
    /artifact is malformed or outside v1/,
  );

  console.log("Reviewed local semantics contract regression: PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}

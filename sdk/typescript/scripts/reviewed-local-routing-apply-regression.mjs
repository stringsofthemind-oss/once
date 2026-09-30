import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildReviewedLocalProtectionPreview } from "../dist/reviewed-local-preview.js";
import { applyReviewedLocalRouting } from "../dist/reviewed-local-routing-apply.js";
import { buildReviewedLocalRoutingPreview } from "../dist/reviewed-local-routing-preview.js";
import { writeReviewedLocalRoutingReview } from "../dist/reviewed-local-routing-review.js";
import { writeReviewedLocalSemanticsPlan } from "../dist/reviewed-local-semantics.js";

const root = process.cwd();
const tempRoot = path.join(root, ".reviewed-local-routing-apply-temp");

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

async function setupProject(name, callerCount = 1) {
  const project = path.join(tempRoot, name);
  const onceDir = path.join(project, ".once");
  await mkdir(onceDir, { recursive: true });
  await writeFile(path.join(project, "booking.mjs"), targetSource, "utf8");
  for (let index = 0; index < callerCount; index += 1) {
    const file = index === 0 ? "checkout.mjs" : `checkout-${index + 1}.mjs`;
    await writeFile(path.join(project, file), callerSource, "utf8");
  }
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

  await writeReviewedLocalSemanticsPlan(project, {
    target: "booking.mjs:createBooking",
    idPrefix: "create-booking",
    idPath: "intentId",
    payloadPaths: ["intentId", "guest"],
    confirmReviewed: true,
  });

  const companion = await buildReviewedLocalProtectionPreview(project);
  const companionPath = path.join(project, companion.output.file);
  await mkdir(path.dirname(companionPath), { recursive: true });
  await writeFile(companionPath, companion.output.module_source, "utf8");

  const routingPreview = await buildReviewedLocalRoutingPreview(project);
  assert.equal(routingPreview.status, "PATCHABLE_PREVIEW");
  assert.equal(routingPreview.routes.length, callerCount);
  const routingReview = await writeReviewedLocalRoutingReview(project, true);

  return { project, companion, companionPath, routingPreview, routingReview };
}

await rm(tempRoot, { recursive: true, force: true });
await mkdir(tempRoot, { recursive: true });

try {
  const primary = await setupProject("primary");
  const callerPath = path.join(primary.project, "checkout.mjs");
  const reviewedRoute = primary.routingReview.review.routes[0];

  const applied = await applyReviewedLocalRouting(primary.project);
  assert.equal(applied.kind, "reviewed_local_routing_apply_v1");
  assert.equal(applied.schema_version, 1);
  assert.equal(applied.file, "checkout.mjs");
  assert.equal(applied.function_name, "createBooking");
  assert.equal(applied.routing_review_fingerprint, primary.routingReview.review.routing_review_fingerprint);
  assert.equal(applied.source_sha256, reviewedRoute.source_sha256);
  assert.equal(applied.applied_sha256, reviewedRoute.result_source_sha256);
  assert.equal(applied.source_modified, true);
  assert.equal(applied.generated_file_modified, false);
  assert.equal(applied.application_wired, true);

  const routedSource = await readFile(callerPath, "utf8");
  assert.equal(routedSource.slice(reviewedRoute.replacement.start, reviewedRoute.replacement.start + reviewedRoute.replacement.after.length), reviewedRoute.replacement.after);
  assert.doesNotMatch(routedSource, /from '\.\/booking\.mjs'/);
  assert.match(routedSource, /return await submitBooking\(input\);/);
  assert.equal(await readFile(applied.backup_path, "utf8"), callerSource);
  assert.equal(await readFile(path.join(primary.project, "booking.mjs"), "utf8"), targetSource);
  assert.equal(await readFile(primary.companionPath, "utf8"), primary.companion.output.module_source);

  const routedSnapshot = routedSource;
  await assert.rejects(
    () => applyReviewedLocalRouting(primary.project),
    /no longer exactly one PATCHABLE_PREVIEW route|differs from the developer-reviewed routing evidence/,
  );
  assert.equal(await readFile(callerPath, "utf8"), routedSnapshot);

  const stale = await setupProject("stale");
  const staleCallerPath = path.join(stale.project, "checkout.mjs");
  const staleSource = callerSource + "// developer edit after review\n";
  await writeFile(staleCallerPath, staleSource, "utf8");
  await assert.rejects(
    () => applyReviewedLocalRouting(stale.project),
    /differs from the developer-reviewed routing evidence|stale/,
  );
  assert.equal(await readFile(staleCallerPath, "utf8"), staleSource);

  const companionDrift = await setupProject("companion-drift");
  await writeFile(
    companionDrift.companionPath,
    companionDrift.companion.output.module_source + "// drift\n",
    "utf8",
  );
  await assert.rejects(
    () => applyReviewedLocalRouting(companionDrift.project),
    /differs from the reviewed deterministic preview/,
  );
  assert.equal(
    await readFile(path.join(companionDrift.project, "checkout.mjs"), "utf8"),
    callerSource,
  );

  const multi = await setupProject("multi", 2);
  const multiFirst = path.join(multi.project, "checkout.mjs");
  const multiSecond = path.join(multi.project, "checkout-2.mjs");
  await assert.rejects(
    () => applyReviewedLocalRouting(multi.project),
    /requires exactly one caller module/,
  );
  assert.equal(await readFile(multiFirst, "utf8"), callerSource);
  assert.equal(await readFile(multiSecond, "utf8"), callerSource);

  const tampered = await setupProject("tampered");
  const reviewPath = path.join(tampered.project, ".once", "reviewed-local-routing-review.json");
  const reviewJson = JSON.parse(await readFile(reviewPath, "utf8"));
  reviewJson.review.routes[0].replacement.after = "'./not-reviewed.mjs'";
  await writeFile(reviewPath, JSON.stringify(reviewJson, null, 2) + "\n", "utf8");
  await assert.rejects(
    () => applyReviewedLocalRouting(tampered.project),
    /malformed|fingerprint/,
  );
  assert.equal(
    await readFile(path.join(tampered.project, "checkout.mjs"), "utf8"),
    callerSource,
  );

  console.log("Reviewed local routing transactional apply regression: PASS");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

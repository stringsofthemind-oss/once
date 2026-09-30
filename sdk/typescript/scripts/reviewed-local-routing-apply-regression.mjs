import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildReviewedLocalProtectionPreview } from "../dist/reviewed-local-preview.js";
import {
  REVIEWED_LOCAL_ROUTING_APPLY_FILE,
  REVIEWED_LOCAL_ROUTING_TRANSACTION_FILE,
  applyReviewedLocalRouting,
} from "../dist/reviewed-local-routing-apply.js";
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

const callerOneSource = [
  "import { createBooking as submitBooking } from './booking.mjs';",
  "export async function checkout(input) {",
  "  return await submitBooking(input);",
  "}",
  "",
].join("\n");

const callerTwoSource = [
  "import { createBooking } from './booking.mjs';",
  "export async function retryCheckout(input) {",
  "  return createBooking(input);",
  "}",
  "",
].join("\n");

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function setupScenario(name) {
  const temp = path.join(tempRoot, name);
  const onceDir = path.join(temp, ".once");
  const targetPath = path.join(temp, "booking.mjs");
  const callerOnePath = path.join(temp, "checkout.mjs");
  const callerTwoPath = path.join(temp, "retry.mjs");

  await rm(temp, { recursive: true, force: true });
  await mkdir(onceDir, { recursive: true });
  await writeFile(targetPath, targetSource, "utf8");
  await writeFile(callerOnePath, callerOneSource, "utf8");
  await writeFile(callerTwoPath, callerTwoSource, "utf8");
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
  assert.equal(preview.routes.length, 2);
  const review = await writeReviewedLocalRoutingReview(temp, true);

  return {
    temp,
    onceDir,
    targetPath,
    callerOnePath,
    callerTwoPath,
    companionPath,
    companion,
    preview,
    review,
  };
}

await rm(tempRoot, { recursive: true, force: true });
await mkdir(tempRoot, { recursive: true });

try {
  const confirmation = await setupScenario("confirmation");
  await assert.rejects(
    () => applyReviewedLocalRouting(confirmation.temp, false),
    /explicit confirmation/,
  );
  assert.equal(await readFile(confirmation.callerOnePath, "utf8"), callerOneSource);
  assert.equal(await readFile(confirmation.callerTwoPath, "utf8"), callerTwoSource);

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const runtimeReady = major > 24 || (major === 24 && minor >= 15);
  if (!runtimeReady) {
    await assert.rejects(
      () => applyReviewedLocalRouting(confirmation.temp, true),
      /requires Node\.js 24\.15 or later/,
    );
    assert.equal(await readFile(confirmation.callerOnePath, "utf8"), callerOneSource);
    assert.equal(await readFile(confirmation.callerTwoPath, "utf8"), callerTwoSource);
    console.log("Reviewed local routing apply regression: PASS (runtime refusal path)");
  } else {
    const stale = await setupScenario("stale");
    const changedSecond = callerTwoSource + "// changed after routing review\n";
    await writeFile(stale.callerTwoPath, changedSecond, "utf8");
    await assert.rejects(
      () => applyReviewedLocalRouting(stale.temp, true),
      /differs from the developer-reviewed|stale|drifted/,
    );
    assert.equal(await readFile(stale.callerOnePath, "utf8"), callerOneSource);
    assert.equal(await readFile(stale.callerTwoPath, "utf8"), changedSecond);
    assert.equal(
      await exists(path.join(stale.onceDir, REVIEWED_LOCAL_ROUTING_APPLY_FILE)),
      false,
    );
    assert.equal(
      await exists(path.join(stale.onceDir, REVIEWED_LOCAL_ROUTING_TRANSACTION_FILE)),
      false,
    );

    const unfinished = await setupScenario("unfinished");
    await writeFile(
      path.join(unfinished.onceDir, REVIEWED_LOCAL_ROUTING_TRANSACTION_FILE),
      "{}\n",
      "utf8",
    );
    await assert.rejects(
      () => applyReviewedLocalRouting(unfinished.temp, true),
      /unfinished reviewed routing transaction/,
    );
    assert.equal(await readFile(unfinished.callerOnePath, "utf8"), callerOneSource);
    assert.equal(await readFile(unfinished.callerTwoPath, "utf8"), callerTwoSource);

    const success = await setupScenario("success");
    const targetBefore = await readFile(success.targetPath, "utf8");
    const companionBefore = await readFile(success.companionPath, "utf8");
    const receipt = await applyReviewedLocalRouting(success.temp, true);

    assert.equal(receipt.kind, "reviewed_local_routing_apply_v1");
    assert.equal(receipt.source_modified, true);
    assert.equal(receipt.generated_file_modified, false);
    assert.equal(receipt.application_wired, true);
    assert.equal(
      receipt.routing_review_fingerprint,
      success.review.review.routing_review_fingerprint,
    );
    assert.equal(receipt.inventory_fingerprint, success.preview.inventory_fingerprint);
    assert.equal(receipt.files.length, 2);
    assert.equal(await readFile(success.targetPath, "utf8"), targetBefore);
    assert.equal(await readFile(success.companionPath, "utf8"), companionBefore);

    const callerOneApplied = await readFile(success.callerOnePath, "utf8");
    const callerTwoApplied = await readFile(success.callerTwoPath, "utf8");
    assert.doesNotMatch(callerOneApplied, /from '\.\/booking\.mjs'/);
    assert.doesNotMatch(callerTwoApplied, /from '\.\/booking\.mjs'/);
    assert.match(
      callerOneApplied,
      /from '\.\/\.once\/generated\/createBooking-[0-9a-f]{12}\.once\.mjs'/,
    );
    assert.match(
      callerTwoApplied,
      /from '\.\/\.once\/generated\/createBooking-[0-9a-f]{12}\.once\.mjs'/,
    );

    for (const file of receipt.files) {
      const backup = await readFile(path.join(success.temp, file.backup_file), "utf8");
      if (file.file === "checkout.mjs") assert.equal(backup, callerOneSource);
      if (file.file === "retry.mjs") assert.equal(backup, callerTwoSource);
      assert.match(file.source_sha256, /^[0-9a-f]{64}$/);
      assert.match(file.applied_sha256, /^[0-9a-f]{64}$/);
    }

    const receiptPath = path.join(success.onceDir, REVIEWED_LOCAL_ROUTING_APPLY_FILE);
    assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), receipt);
    assert.equal(
      await exists(path.join(success.onceDir, REVIEWED_LOCAL_ROUTING_TRANSACTION_FILE)),
      false,
    );

    await assert.rejects(
      () => applyReviewedLocalRouting(success.temp, true),
      /already been applied/,
    );
    assert.equal(await readFile(success.callerOnePath, "utf8"), callerOneApplied);
    assert.equal(await readFile(success.callerTwoPath, "utf8"), callerTwoApplied);

    console.log("Reviewed local routing apply regression: PASS");
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

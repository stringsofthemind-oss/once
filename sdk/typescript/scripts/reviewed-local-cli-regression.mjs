import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "dist", "once-cli.js");
const temp = path.join(root, ".reviewed-local-cli-temp");
const sourcePath = path.join(temp, "http-order.mjs");
const onceDir = path.join(temp, ".once");
const reviewPath = path.join(onceDir, "reviewed-local-semantics.json");

const source = [
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
      file: "http-order.mjs",
      function_name: "createHttpOrder",
      confidence: "MEDIUM",
      category: "HTTP_WRITE",
      automation_status: "PROVIDER_MAPPING_REQUIRED",
      auto_apply_eligible: false,
    },
  ],
};

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ONCE_API_KEY: "",
    },
  });
}

function combined(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

await rm(temp, { recursive: true, force: true });
await mkdir(onceDir, { recursive: true });
await writeFile(sourcePath, source, "utf8");
await writeFile(
  path.join(onceDir, "protect-plan.json"),
  JSON.stringify(protectPlan, null, 2) + "\n",
  "utf8",
);

try {
  const help = run(["--help"]);
  assert.equal(help.status, 0, combined(help));
  assert.match(help.stdout, /once review-local \[directory\]/);
  assert.match(help.stdout, /review artifact is intentionally non-runnable/);
  assert.match(help.stdout, /does not infer business identity or payload completeness/);

  const noConfirm = run([
    "review-local",
    temp,
    "--target=http-order.mjs:createHttpOrder",
    "--id-prefix=create-http-order",
    "--id-path=checkoutId",
    "--payload-paths=checkoutId,sku,quantity",
  ]);
  assert.notEqual(noConfirm.status, 0);
  assert.match(combined(noConfirm), /requires --confirm-reviewed/);
  assert.equal(await exists(reviewPath), false);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  const missingIdentityBinding = run([
    "review-local",
    temp,
    "--target=http-order.mjs:createHttpOrder",
    "--id-prefix=create-http-order",
    "--id-path=checkoutId",
    "--payload-paths=sku,quantity",
    "--confirm-reviewed",
  ]);
  assert.notEqual(missingIdentityBinding.status, 0);
  assert.match(combined(missingIdentityBinding), /must include the selected identity path/);
  assert.equal(await exists(reviewPath), false);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  const applyAttempt = run([
    "review-local",
    temp,
    "--target=http-order.mjs:createHttpOrder",
    "--id-prefix=create-http-order",
    "--id-path=checkoutId",
    "--payload-paths=checkoutId,sku,quantity",
    "--confirm-reviewed",
    "--apply",
  ]);
  assert.notEqual(applyAttempt.status, 0);
  assert.match(combined(applyAttempt), /unsupported option/);
  assert.equal(await exists(reviewPath), false);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  const reviewed = run([
    "review-local",
    temp,
    "--target=http-order.mjs:createHttpOrder",
    "--id-prefix=create-http-order",
    "--id-path=checkoutId",
    "--payload-paths=checkoutId,sku,quantity",
    "--confirm-reviewed",
  ]);
  assert.equal(reviewed.status, 0, combined(reviewed));
  assert.match(reviewed.stdout, /Once Reviewed Local Semantics/);
  assert.match(
    reviewed.stdout,
    /Observed candidate: MEDIUM · HTTP_WRITE · PROVIDER_MAPPING_REQUIRED/,
  );
  assert.match(reviewed.stdout, /Observed top-level inputs: checkoutId, sku, quantity \(observation only\)/);
  assert.match(reviewed.stdout, /Reviewed identity path: checkoutId/);
  assert.match(reviewed.stdout, /Reviewed payload paths: checkoutId, sku, quantity/);
  assert.match(reviewed.stdout, /Developer confirmed: yes/);
  assert.match(reviewed.stdout, /Source modified: no/);
  assert.match(reviewed.stdout, /Runnable: no/);
  assert.match(reviewed.stdout, /does not generate, apply, or execute protection/);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  const artifact = JSON.parse(await readFile(reviewPath, "utf8"));
  assert.equal(artifact.kind, "reviewed_local_semantics_v1");
  assert.equal(artifact.source_modified, false);
  assert.equal(artifact.runnable, false);
  assert.equal(artifact.target.file, "http-order.mjs");
  assert.equal(artifact.target.function_name, "createHttpOrder");
  assert.equal(artifact.target.candidate.auto_apply_eligible, false);
  assert.deepEqual(artifact.target.source_observations.top_level_fields, [
    "checkoutId",
    "sku",
    "quantity",
  ]);
  assert.equal(artifact.review.developer_confirmed, true);
  assert.equal(artifact.review.identity.prefix, "create-http-order");
  assert.equal(artifact.review.identity.path, "checkoutId");
  assert.deepEqual(artifact.review.payload.paths, [
    "checkoutId",
    "sku",
    "quantity",
  ]);

  const secondReview = run([
    "review-local",
    temp,
    "--target=http-order.mjs:createHttpOrder",
    "--id-prefix=create-http-order",
    "--id-path=checkoutId",
    "--payload-paths=checkoutId,sku,quantity",
    "--confirm-reviewed",
  ]);
  assert.notEqual(secondReview.status, 0);
  assert.match(combined(secondReview), /EEXIST/);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  console.log("Reviewed local public CLI regression: PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}

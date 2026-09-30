import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "dist", "once-cli.js");
const temp = path.join(root, ".reviewed-local-cli-temp");
const sourcePath = path.join(temp, "http-order.mjs");
const onceDir = path.join(temp, ".once");
const reviewPath = path.join(onceDir, "reviewed-local-semantics.json");
const generatedDir = path.join(onceDir, "generated");

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

  const previewBeforeReview = run([
    "review-local",
    temp,
    "--preview",
  ]);
  assert.notEqual(previewBeforeReview.status, 0);
  assert.match(combined(previewBeforeReview), /reviewed-local-semantics\.json|ENOENT/);
  assert.equal(await exists(generatedDir), false);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  const previewWithSemantics = run([
    "review-local",
    temp,
    "--preview",
    "--target=http-order.mjs:createHttpOrder",
    "--id-prefix=create-http-order",
    "--id-path=checkoutId",
    "--payload-paths=checkoutId,sku,quantity",
  ]);
  assert.notEqual(previewWithSemantics.status, 0);
  assert.match(combined(previewWithSemantics), /uses only the already-reviewed/);
  assert.equal(await exists(reviewPath), false);
  assert.equal(await exists(generatedDir), false);
  assert.equal(await readFile(sourcePath, "utf8"), source);

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
  assert.match(reviewed.stdout, /once review-local .* --preview/);
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

  const preview = run([
    "review-local",
    temp,
    "--preview",
  ]);
  assert.equal(preview.status, 0, combined(preview));
  assert.match(preview.stdout, /Once Reviewed Local Protection Preview/);
  assert.match(preview.stdout, /Target: http-order\.mjs:createHttpOrder/);
  assert.match(preview.stdout, /Review fingerprint: [0-9a-f]{64}/);
  assert.match(
    preview.stdout,
    /Proposed module: \.once\/generated\/createHttpOrder-[0-9a-f]{12}\.once\.mjs/,
  );
  assert.match(preview.stdout, /Module SHA-256: [0-9a-f]{64}/);
  assert.match(preview.stdout, /Source modified: no/);
  assert.match(preview.stdout, /Generated file written: no/);
  assert.match(preview.stdout, /Runnable integration active: no/);
  assert.match(
    preview.stdout,
    /import \{ Once as __OnceAgentId, protectLocal as __OnceProtectLocal \} from "@once-agent\/sdk";/,
  );
  assert.match(
    preview.stdout,
    /import \{ createHttpOrder as __OnceOriginal \} from "\.\.\/\.\.\/http-order\.mjs";/,
  );
  assert.match(
    preview.stdout,
    /id: input => __OnceAgentId\.id\("create-http-order", input\["checkoutId"\]\)/,
  );
  assert.match(preview.stdout, /"checkoutId": input\["checkoutId"\]/);
  assert.match(preview.stdout, /"sku": input\["sku"\]/);
  assert.match(preview.stdout, /"quantity": input\["quantity"\]/);
  assert.match(preview.stdout, /Preview only: Once did not write this module/);
  assert.match(preview.stdout, /requires Node\.js 24\.15\+/);
  assert.match(preview.stdout, /--materialize --confirm-materialize/);
  assert.equal(await exists(generatedDir), false);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  await writeFile(sourcePath, source + "// changed after review\n", "utf8");
  const stalePreview = run([
    "review-local",
    temp,
    "--preview",
  ]);
  assert.notEqual(stalePreview.status, 0);
  assert.match(combined(stalePreview), /Source changed after reviewed local semantics were recorded/);
  assert.equal(await exists(generatedDir), false);
  await writeFile(sourcePath, source, "utf8");

  const materializeWithSemantics = run([
    "review-local",
    temp,
    "--materialize",
    "--confirm-materialize",
    "--target=http-order.mjs:createHttpOrder",
  ]);
  assert.notEqual(materializeWithSemantics.status, 0);
  assert.match(combined(materializeWithSemantics), /does not accept semantic review options/);
  assert.equal(await exists(generatedDir), false);

  const materializeWithoutConfirm = run([
    "review-local",
    temp,
    "--materialize",
  ]);
  assert.notEqual(materializeWithoutConfirm.status, 0);
  assert.match(combined(materializeWithoutConfirm), /requires --confirm-materialize/);
  assert.equal(await exists(generatedDir), false);

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const localRuntimeReady = major > 24 || (major === 24 && minor >= 15);
  const materialized = run([
    "review-local",
    temp,
    "--materialize",
    "--confirm-materialize",
  ]);

  if (!localRuntimeReady) {
    assert.notEqual(materialized.status, 0);
    assert.match(combined(materialized), /requires Node\.js 24\.15 or later/);
    assert.equal(await exists(generatedDir), false);
  } else {
    assert.equal(materialized.status, 0, combined(materialized));
    assert.match(materialized.stdout, /Once Reviewed Local Companion Materialized/);
    assert.match(
      materialized.stdout,
      /Generated module: \.once\/generated\/createHttpOrder-[0-9a-f]{12}\.once\.mjs/,
    );
    assert.match(materialized.stdout, /Module SHA-256: [0-9a-f]{64}/);
    assert.match(materialized.stdout, /Application source modified: no/);
    assert.match(materialized.stdout, /Application import\/call site modified: no/);
    assert.match(materialized.stdout, /Application integration active: no/);
    assert.match(materialized.stdout, /durable same-machine protectLocal state/);

    const generatedFiles = await readdir(generatedDir);
    assert.equal(generatedFiles.length, 1);
    assert.match(generatedFiles[0], /^createHttpOrder-[0-9a-f]{12}\.once\.mjs$/);
    const generatedSource = await readFile(
      path.join(generatedDir, generatedFiles[0]),
      "utf8",
    );
    assert.match(
      generatedSource,
      /import \{ Once as __OnceAgentId, protectLocal as __OnceProtectLocal \} from "@once-agent\/sdk";/,
    );
    assert.match(
      generatedSource,
      /import \{ createHttpOrder as __OnceOriginal \} from "\.\.\/\.\.\/http-order\.mjs";/,
    );
    assert.match(
      generatedSource,
      /id: input => __OnceAgentId\.id\("create-http-order", input\["checkoutId"\]\)/,
    );
    assert.equal(await readFile(sourcePath, "utf8"), source);

    const secondMaterialize = run([
      "review-local",
      temp,
      "--materialize",
      "--confirm-materialize",
    ]);
    assert.notEqual(secondMaterialize.status, 0);
    assert.match(combined(secondMaterialize), /already exists/);
    assert.equal((await readdir(generatedDir)).length, 1);
  }

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

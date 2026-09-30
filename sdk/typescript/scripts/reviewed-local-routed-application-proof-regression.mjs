import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { Once } from "../dist/index.js";

const root = process.cwd();
const cli = path.join(root, "dist", "once-cli.js");
const temp = path.join(root, ".reviewed-local-routed-application-proof-temp");
const onceDir = path.join(temp, ".once");
const generatedDir = path.join(onceDir, "generated");
const targetPath = path.join(temp, "effect.mjs");
const applicationPath = path.join(temp, "application.mjs");
const ledgerPath = path.join(temp, "effects.jsonl");
const statePath = path.join(onceDir, "operations.sqlite");
const applyReceiptPath = path.join(onceDir, "reviewed-local-routing-apply.json");

const targetSource = [
  'import { appendFile } from "node:fs/promises";',
  "",
  "export async function createEffect({ intentId, value, dropResponse }) {",
  "  const receipt = { intentId, value };",
  '  await appendFile(new URL("./effects.jsonl", import.meta.url), JSON.stringify(receipt) + "\\n", "utf8");',
  '  if (dropResponse) throw new Error("Effect committed; response lost");',
  "  return receipt;",
  "}",
  "",
].join("\n");

const applicationSource = [
  'import { createEffect } from "./effect.mjs";',
  "",
  "export async function runApplication(input) {",
  "  return createEffect(input);",
  "}",
  "",
].join("\n");

const protectPlan = {
  candidates: [
    {
      file: "effect.mjs",
      function_name: "createEffect",
      confidence: "MEDIUM",
      category: "FILE_WRITE",
      automation_status: "MANUAL_REVIEW",
      auto_apply_eligible: false,
    },
  ],
};

function runCli(args) {
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

function runApplication(input) {
  const script = [
    'import { pathToFileURL } from "node:url";',
    `const application = await import(pathToFileURL(${JSON.stringify(applicationPath)}).href);`,
    `const input = ${JSON.stringify(input)};`,
    "try {",
    "  const result = await application.runApplication(input);",
    '  process.stdout.write(JSON.stringify({ ok: true, result }));',
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({",
    "    ok: false,",
    "    name: error?.name ?? null,",
    "    code: error?.code ?? null,",
    "    message: error?.message ?? String(error),",
    "  }));",
    "}",
  ].join("\n");

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: temp,
      encoding: "utf8",
      env: {
        ...process.env,
        ONCE_API_KEY: "",
      },
    },
  );
  assert.equal(result.status, 0, combined(result));
  return JSON.parse(result.stdout);
}

async function ledger() {
  try {
    const raw = await readFile(ledgerPath, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
assert.ok(
  major > 24 || (major === 24 && minor >= 15),
  "Active reviewed application routing proof requires Node.js 24.15+.",
);

await rm(temp, { recursive: true, force: true });
await mkdir(onceDir, { recursive: true });
await writeFile(targetPath, targetSource, "utf8");
await writeFile(applicationPath, applicationSource, "utf8");
await writeFile(
  path.join(onceDir, "protect-plan.json"),
  JSON.stringify(protectPlan, null, 2) + "\n",
  "utf8",
);

try {
  const reviewSemantics = runCli([
    "review-local",
    temp,
    "--target=effect.mjs:createEffect",
    "--id-prefix=create-effect",
    "--id-path=intentId",
    "--payload-paths=intentId,value",
    "--confirm-reviewed",
  ]);
  assert.equal(reviewSemantics.status, 0, combined(reviewSemantics));
  assert.match(reviewSemantics.stdout, /Reviewed identity path: intentId/);
  assert.match(reviewSemantics.stdout, /Reviewed payload paths: intentId, value/);

  const materialize = runCli([
    "review-local",
    temp,
    "--materialize",
    "--confirm-materialize",
  ]);
  assert.equal(materialize.status, 0, combined(materialize));
  assert.match(materialize.stdout, /Once Reviewed Local Companion Materialized/);
  assert.match(materialize.stdout, /Application integration active: no/);

  const generatedFiles = await readdir(generatedDir);
  assert.equal(generatedFiles.length, 1);
  assert.match(generatedFiles[0], /^createEffect-[0-9a-f]{12}\.once\.mjs$/);
  const generatedPath = path.join(generatedDir, generatedFiles[0]);
  const generatedBeforeRouting = await readFile(generatedPath, "utf8");

  const inventory = runCli([
    "review-local",
    temp,
    "--inventory-callers",
  ]);
  assert.equal(inventory.status, 0, combined(inventory));
  assert.match(inventory.stdout, /Status: READY_FOR_ROUTING_REVIEW/);
  assert.match(inventory.stdout, /Proven caller modules: 1/);
  assert.match(inventory.stdout, /Proven direct call sites: 1/);
  assert.match(inventory.stdout, /Caller: application\.mjs imports createEffect as createEffect/);

  const routingPreview = runCli([
    "review-local",
    temp,
    "--preview-routing",
  ]);
  assert.equal(routingPreview.status, 0, combined(routingPreview));
  assert.match(routingPreview.stdout, /Status: PATCHABLE_PREVIEW/);
  assert.match(routingPreview.stdout, /Proposed caller import changes: 1/);
  assert.match(routingPreview.stdout, /Before: "\.\/effect\.mjs"/);
  assert.match(
    routingPreview.stdout,
    /After:\s+"\.\/\.once\/generated\/createEffect-[0-9a-f]{12}\.once\.mjs"/,
  );
  assert.equal(await readFile(applicationPath, "utf8"), applicationSource);

  const routingReview = runCli([
    "review-local",
    temp,
    "--review-routing",
    "--confirm-routing-reviewed",
  ]);
  assert.equal(routingReview.status, 0, combined(routingReview));
  assert.match(routingReview.stdout, /Once Reviewed Local Routing Approved/);
  assert.match(routingReview.stdout, /Reviewed routes: 1/);
  assert.match(routingReview.stdout, /Application integration active: no/);
  assert.equal(await readFile(applicationPath, "utf8"), applicationSource);

  const routingApply = runCli([
    "review-local",
    temp,
    "--apply-routing",
    "--confirm-routing-apply",
  ]);
  assert.equal(routingApply.status, 0, combined(routingApply));
  assert.match(routingApply.stdout, /Once Reviewed Local Routing Applied/);
  assert.match(routingApply.stdout, /Applied caller modules: 1/);
  assert.match(routingApply.stdout, /Application integration active: yes/);

  const applicationAfterRouting = await readFile(applicationPath, "utf8");
  assert.doesNotMatch(applicationAfterRouting, /from "\.\/effect\.mjs"/);
  assert.match(
    applicationAfterRouting,
    /from "\.\/\.once\/generated\/createEffect-[0-9a-f]{12}\.once\.mjs"/,
  );
  assert.equal(await readFile(targetPath, "utf8"), targetSource);
  assert.equal(await readFile(generatedPath, "utf8"), generatedBeforeRouting);

  const applyReceipt = JSON.parse(await readFile(applyReceiptPath, "utf8"));
  assert.equal(applyReceipt.kind, "reviewed_local_routing_apply_v1");
  assert.equal(applyReceipt.application_wired, true);
  assert.equal(applyReceipt.files.length, 1);
  assert.equal(applyReceipt.files[0].file, "application.mjs");

  const firstInput = {
    intentId: "application-confirmed",
    value: "alpha",
    dropResponse: false,
  };
  const first = runApplication(firstInput);
  assert.deepEqual(first, {
    ok: true,
    result: { intentId: "application-confirmed", value: "alpha" },
  });
  assert.deepEqual(await ledger(), [
    { intentId: "application-confirmed", value: "alpha" },
  ]);

  const replay = runApplication(firstInput);
  assert.deepEqual(replay, first);
  assert.deepEqual(await ledger(), [
    { intentId: "application-confirmed", value: "alpha" },
  ]);

  const conflict = runApplication({
    intentId: "application-confirmed",
    value: "beta",
    dropResponse: false,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "CONFLICT");
  assert.match(conflict.message, /different effect-bearing payload/);
  assert.deepEqual(await ledger(), [
    { intentId: "application-confirmed", value: "alpha" },
  ]);

  const ambiguous = runApplication({
    intentId: "application-unknown",
    value: "gamma",
    dropResponse: true,
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, "UNKNOWN");
  assert.match(ambiguous.message, /external outcome may be unknown|response lost/i);
  assert.deepEqual(await ledger(), [
    { intentId: "application-confirmed", value: "alpha" },
    { intentId: "application-unknown", value: "gamma" },
  ]);

  const unknownRetry = runApplication({
    intentId: "application-unknown",
    value: "gamma",
    dropResponse: false,
  });
  assert.equal(unknownRetry.ok, false);
  assert.equal(unknownRetry.code, "UNKNOWN");
  assert.match(unknownRetry.message, /no second write was dispatched|Outcome of/);
  assert.deepEqual(await ledger(), [
    { intentId: "application-confirmed", value: "alpha" },
    { intentId: "application-unknown", value: "gamma" },
  ]);

  const db = new DatabaseSync(statePath);
  try {
    const rows = db
      .prepare("SELECT id,state,result_json FROM local_operations ORDER BY id")
      .all();
    assert.equal(rows.length, 2);

    const confirmedId = Once.id("create-effect", "application-confirmed");
    const unknownId = Once.id("create-effect", "application-unknown");
    const byId = new Map(rows.map(row => [row.id, row]));

    assert.equal(byId.get(confirmedId)?.state, "CONFIRMED");
    assert.equal(typeof byId.get(confirmedId)?.result_json, "string");
    assert.equal(byId.get(unknownId)?.state, "UNKNOWN");
    assert.equal(byId.get(unknownId)?.result_json, null);
  } finally {
    db.close();
  }

  assert.equal(await readFile(targetPath, "utf8"), targetSource);
  assert.equal(await readFile(generatedPath, "utf8"), generatedBeforeRouting);
  assert.match(await readFile(applicationPath, "utf8"), /\.once\/generated\/createEffect-/);

  console.log("Reviewed local routed application execution proof: PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}

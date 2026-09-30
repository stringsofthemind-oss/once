import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { Once } from "../dist/index.js";

const root = process.cwd();
const cli = path.join(root, "dist", "once-cli.js");
const temp = path.join(root, ".materialized-companion-proof-temp");
const onceDir = path.join(temp, ".once");
const generatedDir = path.join(onceDir, "generated");
const sourcePath = path.join(temp, "effect.mjs");
const runnerPath = path.join(temp, "run-generated.mjs");
const ledgerPath = path.join(temp, "effects.jsonl");
const statePath = path.join(onceDir, "operations.sqlite");

const source = [
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

const runner = [
  'import { pathToFileURL } from "node:url";',
  "",
  "const [modulePath, inputJson] = process.argv.slice(2);",
  "const input = JSON.parse(inputJson);",
  "const generated = await import(pathToFileURL(modulePath).href);",
  "try {",
  "  const result = await generated.createEffect(input);",
  '  process.stdout.write(JSON.stringify({ ok: true, result }));',
  "} catch (error) {",
  "  process.stdout.write(JSON.stringify({",
  "    ok: false,",
  "    name: error?.name ?? null,",
  "    code: error?.code ?? null,",
  "    message: error?.message ?? String(error),",
  "  }));",
  "}",
  "",
].join("\n");

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

function runProtected(generatedPath, input) {
  const result = spawnSync(
    process.execPath,
    [runnerPath, generatedPath, JSON.stringify(input)],
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
  "Materialized companion execution proof requires Node.js 24.15+.",
);

await rm(temp, { recursive: true, force: true });
await mkdir(onceDir, { recursive: true });
await writeFile(sourcePath, source, "utf8");
await writeFile(runnerPath, runner, "utf8");
await writeFile(
  path.join(onceDir, "protect-plan.json"),
  JSON.stringify(protectPlan, null, 2) + "\n",
  "utf8",
);

try {
  const review = runCli([
    "review-local",
    temp,
    "--target=effect.mjs:createEffect",
    "--id-prefix=create-effect",
    "--id-path=intentId",
    "--payload-paths=intentId,value",
    "--confirm-reviewed",
  ]);
  assert.equal(review.status, 0, combined(review));
  assert.match(review.stdout, /Reviewed identity path: intentId/);
  assert.match(review.stdout, /Reviewed payload paths: intentId, value/);

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
  const generatedPath = path.join(generatedDir, generatedFiles[0]);
  assert.match(generatedFiles[0], /^createEffect-[0-9a-f]{12}\.once\.mjs$/);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  const firstInput = {
    intentId: "proof-confirmed",
    value: "alpha",
    dropResponse: false,
  };
  const first = runProtected(generatedPath, firstInput);
  assert.deepEqual(first, {
    ok: true,
    result: { intentId: "proof-confirmed", value: "alpha" },
  });
  assert.deepEqual(await ledger(), [
    { intentId: "proof-confirmed", value: "alpha" },
  ]);

  const replay = runProtected(generatedPath, firstInput);
  assert.deepEqual(replay, first);
  assert.deepEqual(await ledger(), [
    { intentId: "proof-confirmed", value: "alpha" },
  ]);

  const conflict = runProtected(generatedPath, {
    intentId: "proof-confirmed",
    value: "beta",
    dropResponse: false,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "CONFLICT");
  assert.match(conflict.message, /different effect-bearing payload/);
  assert.deepEqual(await ledger(), [
    { intentId: "proof-confirmed", value: "alpha" },
  ]);

  const ambiguous = runProtected(generatedPath, {
    intentId: "proof-unknown",
    value: "gamma",
    dropResponse: true,
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, "UNKNOWN");
  assert.match(ambiguous.message, /external outcome may be unknown|response lost/i);
  assert.deepEqual(await ledger(), [
    { intentId: "proof-confirmed", value: "alpha" },
    { intentId: "proof-unknown", value: "gamma" },
  ]);

  const unknownRetry = runProtected(generatedPath, {
    intentId: "proof-unknown",
    value: "gamma",
    dropResponse: false,
  });
  assert.equal(unknownRetry.ok, false);
  assert.equal(unknownRetry.code, "UNKNOWN");
  assert.match(unknownRetry.message, /no second write was dispatched|Outcome of/);
  assert.deepEqual(await ledger(), [
    { intentId: "proof-confirmed", value: "alpha" },
    { intentId: "proof-unknown", value: "gamma" },
  ]);

  const db = new DatabaseSync(statePath);
  try {
    const rows = db
      .prepare("SELECT id,state,result_json FROM local_operations ORDER BY id")
      .all();
    assert.equal(rows.length, 2);

    const confirmedId = Once.id("create-effect", "proof-confirmed");
    const unknownId = Once.id("create-effect", "proof-unknown");
    const byId = new Map(rows.map(row => [row.id, row]));

    assert.equal(byId.get(confirmedId)?.state, "CONFIRMED");
    assert.equal(typeof byId.get(confirmedId)?.result_json, "string");
    assert.equal(byId.get(unknownId)?.state, "UNKNOWN");
    assert.equal(byId.get(unknownId)?.result_json, null);
  } finally {
    db.close();
  }

  assert.equal(await readFile(sourcePath, "utf8"), source);
  assert.equal((await readdir(generatedDir)).length, 1);
  console.log("Materialized reviewed companion execution proof: PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}

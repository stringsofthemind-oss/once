import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { applyProtectionPlan } from "../dist/apply.js";

const root = process.cwd();
const cli = path.join(root, "dist", "cli.js");
const tempRoot = path.join(root, ".javascript-http-apply-regression-temp");
const targetUrl = "https://api.example.invalid/bookings";
const provider = "javascript-http-test-provider";

async function writeProviderFiles(directory) {
  await mkdir(path.join(directory, ".once"), { recursive: true });

  await writeFile(
    path.join(directory, ".once", "config.json"),
    JSON.stringify(
      {
        version: 1,
        provider: {
          name: provider,
          type: "http_v1",
          version_id: "pv_00000000000000000000000000000000"
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(directory, ".once", "provider-capabilities.json"),
    JSON.stringify(
      {
        schema_version: 1,
        provider,
        capabilities: [
          {
            category: "HTTP_WRITE",
            action_type: "http_write_v1",
            allowed_urls: [targetUrl]
          }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
}

function sourceFor(extension) {
  if (extension === "mjs" || extension === "js" || extension === "cjs") {
    return [
      "export async function createBooking(operationId, payload) {",
      "  await fetch(",
      `    \"${targetUrl}\",`,
      "    {",
      "      method: \"POST\",",
      "      headers: { \"Content-Type\": \"application/json\" },",
      "      body: JSON.stringify(payload)",
      "    }",
      "  );",
      "}",
      ""
    ].join("\n");
  }

  throw new Error(`Unsupported fixture extension ${extension}`);
}

async function createProject(name, extension) {
  const directory = path.join(tempRoot, name);
  const sourceDirectory = path.join(directory, "src");
  const sourcePath = path.join(sourceDirectory, `booking.${extension}`);
  const source = sourceFor(extension);

  await rm(directory, { recursive: true, force: true });
  await mkdir(sourceDirectory, { recursive: true });
  await writeProviderFiles(directory);
  await writeFile(sourcePath, source, "utf8");

  return { directory, sourcePath, source, extension };
}

function runProtect(directory) {
  const result = spawnSync(
    process.execPath,
    [cli, "protect", directory, "--all", "--write-plan"],
    { cwd: root, encoding: "utf8" }
  );

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error("JavaScript HTTP protect regression failed");
  }

  return result.stdout;
}

async function readPlan(directory) {
  return JSON.parse(
    await readFile(path.join(directory, ".once", "protect-plan.json"), "utf8")
  );
}

function onlyCandidate(plan) {
  assert.equal(plan.candidates.length, 1, "Expected exactly one HTTP candidate");
  return plan.candidates[0];
}

await rm(tempRoot, { recursive: true, force: true });
await mkdir(tempRoot, { recursive: true });

console.log("");
console.log("JAVASCRIPT HTTP APPLY REGRESSION");
console.log("================================");

const esm = await createProject("esm-mjs", "mjs");
const esmOutput = runProtect(esm.directory);
const esmCandidate = onlyCandidate(await readPlan(esm.directory));

assert.equal(esmCandidate.file.replaceAll("\\", "/").endsWith("src/booking.mjs"), true);
assert.equal(esmCandidate.source_shape, "SUPPORTED");
assert.equal(esmCandidate.automation_status, "PATCHABLE");
assert.equal(esmCandidate.auto_apply_eligible, true);
assert.equal(esmCandidate.target_url, targetUrl);
assert.equal(esmOutput.includes("PATCHABLE"), true);

const beforeApply = await readFile(esm.sourcePath, "utf8");
assert.equal(beforeApply, esm.source, "Protect planning modified .mjs source");

const applied = await applyProtectionPlan(esm.directory);
const appliedSource = await readFile(esm.sourcePath, "utf8");
const backupSource = await readFile(applied.backupPath, "utf8");

assert.equal(backupSource, esm.source, "Backup did not preserve original .mjs source");
assert.equal(
  appliedSource.includes('import { Once as __OnceAgentClient } from "@once-agent/sdk";'),
  true,
  "Once import missing from transformed .mjs source"
);
assert.equal(
  appliedSource.includes("await new __OnceAgentClient().execute("),
  true,
  "Once execution missing from transformed .mjs source"
);
assert.equal(
  appliedSource.includes("await fetch("),
  false,
  "Original fetch remained in transformed .mjs source"
);
assert.equal(
  appliedSource.includes('method: "POST"'),
  true,
  "POST method was not preserved"
);
assert.equal(
  appliedSource.includes(`url: "${targetUrl}"`),
  true,
  "Literal target URL was not preserved"
);

console.log("PASS - exported .mjs source becomes PATCHABLE");
console.log("PASS - .mjs apply preserves backup and removes original fetch");
console.log("PASS - .mjs apply inserts one bound Once execution path");

for (const extension of ["js", "cjs"]) {
  const rejected = await createProject(`rejected-${extension}`, extension);
  runProtect(rejected.directory);
  const candidate = onlyCandidate(await readPlan(rejected.directory));

  assert.equal(candidate.source_shape, "UNSUPPORTED", `${extension} source unexpectedly became supported`);
  assert.equal(candidate.auto_apply_eligible, false, `${extension} source unexpectedly became auto-apply eligible`);
  assert.notEqual(candidate.automation_status, "PATCHABLE", `${extension} source unexpectedly became PATCHABLE`);
  assert.equal(
    await readFile(rejected.sourcePath, "utf8"),
    rejected.source,
    `${extension} rejection modified source`
  );
}

console.log("PASS - plain .js remains fail-closed in this slice");
console.log("PASS - .cjs remains fail-closed in this slice");

await rm(tempRoot, { recursive: true, force: true });

console.log("");
console.log("JAVASCRIPT HTTP APPLY REGRESSION PASSED");

import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = await mkdtemp(
  path.join(os.tmpdir(), "once-doctor-safe-apply-")
);

const cli = path.resolve("dist/cli.js");

async function writeJson(file, value) {
  await writeFile(
    file,
    JSON.stringify(value, null, 2) + "\n",
    "utf8"
  );
}

async function createProject(name, source, allowedUrls) {
  const directory = path.join(root, name);
  const src = path.join(directory, "src");
  const once = path.join(directory, ".once");

  await mkdir(src, { recursive: true });
  await mkdir(once, { recursive: true });

  const sourcePath = path.join(src, "actions.ts");
  await writeFile(sourcePath, source, "utf8");

  await writeJson(
    path.join(directory, "package.json"),
    {
      name: `doctor-safe-apply-${name}`,
      private: true
    }
  );

  await writeJson(
    path.join(once, "config.json"),
    {
      version: 1,
      provider: {
        name: "doctor-safe-apply-provider",
        type: "http_v1",
        version_id: "pv_00000000000000000000000000000000"
      }
    }
  );

  await writeJson(
    path.join(once, "provider-capabilities.json"),
    {
      schema_version: 1,
      provider: "doctor-safe-apply-provider",
      capabilities: [
        {
          category: "HTTP_WRITE",
          action_type: "http_write_v1",
          allowed_urls: allowedUrls
        }
      ]
    }
  );

  return {
    directory,
    sourcePath,
    receiptPath: path.join(once, "protection-status.json"),
    source
  };
}

function runDoctor(directory, ...flags) {
  return spawnSync(
    process.execPath,
    [cli, "doctor", directory, ...flags],
    {
      encoding: "utf8"
    }
  );
}

const oneCandidateSource = `
export async function createOrder(
  operationId: string,
  payload: unknown
) {
  await fetch(
    "https://api.example.invalid/orders",
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
}
`.trimStart();

const twoCandidateSource = `
export async function createOrder(
  operationId: string,
  payload: unknown
) {
  await fetch(
    "https://api.example.invalid/orders",
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
}

export async function createInvoice(
  operationId: string,
  payload: unknown
) {
  await fetch(
    "https://api.example.invalid/invoices",
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
}
`.trimStart();

try {
  const success = await createProject(
    "success",
    oneCandidateSource,
    ["https://api.example.invalid/orders"]
  );

  const missingProtect = runDoctor(
    success.directory,
    "--apply"
  );

  assert.equal(
    missingProtect.status,
    1,
    "doctor --apply must refuse mutation unless --protect is explicit"
  );
  assert.match(
    missingProtect.stderr,
    /doctor --apply requires --protect/i
  );
  assert.equal(
    await readFile(success.sourcePath, "utf8"),
    oneCandidateSource,
    "rejected apply must not modify source"
  );
  await assert.rejects(
    access(success.receiptPath),
    "rejected apply must not create a protection receipt"
  );

  const applied = runDoctor(
    success.directory,
    "--protect",
    "--apply"
  );

  assert.equal(
    applied.status,
    0,
    `unified doctor safe apply failed\nstdout:\n${applied.stdout}\nstderr:\n${applied.stderr}`
  );
  assert.match(
    applied.stdout,
    /PROTECTION READINESS/
  );
  assert.match(
    applied.stdout,
    /AUTOMATIC WIRING PLAN/
  );
  assert.match(
    applied.stdout,
    /SAFE APPLY/
  );
  assert.match(
    applied.stdout,
    /Protection receipt: .*protection-status\.json/
  );
  assert.match(
    applied.stdout,
    /ONE PROVEN PATCHABLE TRANSFORMATION APPLIED/
  );
  assert.match(
    applied.stdout,
    /Route proof: PENDING \(HOSTED_LOST_ACK_REPLAY_V1\)/
  );
  assert.match(
    applied.stdout,
    /does not claim that every project tool or execution-safety gap is now protected/
  );
  assert.doesNotMatch(
    applied.stdout,
    /ONCE PROTECTED/
  );

  const transformed = await readFile(
    success.sourcePath,
    "utf8"
  );

  assert.match(
    transformed,
    /import \{ Once as __OnceAgentClient \} from "@once-agent\/sdk";/
  );
  assert.match(
    transformed,
    /await new __OnceAgentClient\(\)\.execute\(/
  );
  assert.doesNotMatch(
    transformed,
    /await fetch\(/
  );

  const receipt = JSON.parse(
    await readFile(success.receiptPath, "utf8")
  );

  assert.equal(receipt.schema_version, 1);
  assert.equal(receipt.status, "APPLIED_PENDING_ROUTE_PROOF");
  assert.equal(receipt.once_protected, false);
  assert.equal(receipt.provider, "doctor-safe-apply-provider");
  assert.equal(receipt.transformer_id, "ts_fetch_post_void_v1");
  assert.equal(receipt.execution_route, "HOSTED_ONCE_EXECUTE_V1");
  assert.equal(receipt.route_proof.required, "HOSTED_LOST_ACK_REPLAY_V1");
  assert.equal(receipt.route_proof.state, "PENDING");
  assert.equal(receipt.route_proof.verified_at, null);
  assert.match(receipt.source_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.applied_sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(receipt.source_sha256, receipt.applied_sha256);

  const currentStatus = runDoctor(success.directory);
  assert.equal(currentStatus.status, 0);
  assert.match(currentStatus.stdout, /PROTECTION STATUS/);
  assert.match(
    currentStatus.stdout,
    /Applied transformation receipt: CURRENT/
  );
  assert.match(
    currentStatus.stdout,
    /Execution route: HOSTED_ONCE_EXECUTE_V1/
  );
  assert.match(
    currentStatus.stdout,
    /Route proof: PENDING \(HOSTED_LOST_ACK_REPLAY_V1\)/
  );
  assert.match(
    currentStatus.stdout,
    /Protection claim: pending route-matched hostile-retry proof\./
  );
  assert.doesNotMatch(
    currentStatus.stdout,
    /ONCE PROTECTED/
  );

  await writeFile(
    success.sourcePath,
    transformed + "\n// customer changed source after Once apply\n",
    "utf8"
  );

  const staleStatus = runDoctor(success.directory);
  assert.equal(staleStatus.status, 0);
  assert.match(staleStatus.stdout, /PROTECTION STATUS/);
  assert.match(
    staleStatus.stdout,
    /Applied transformation receipt: STALE_SOURCE/
  );
  assert.match(
    staleStatus.stdout,
    /protected source changed after the recorded Once transformation/i
  );
  assert.doesNotMatch(
    staleStatus.stdout,
    /ONCE PROTECTED/
  );

  const ambiguous = await createProject(
    "ambiguous",
    twoCandidateSource,
    [
      "https://api.example.invalid/orders",
      "https://api.example.invalid/invoices"
    ]
  );

  const ambiguousResult = runDoctor(
    ambiguous.directory,
    "--protect",
    "--apply"
  );

  assert.equal(
    ambiguousResult.status,
    1,
    "unified apply must fail closed when more than one PATCHABLE candidate exists"
  );
  assert.equal(
    await readFile(ambiguous.sourcePath, "utf8"),
    twoCandidateSource,
    "ambiguous apply must not modify application source"
  );
  await assert.rejects(
    access(ambiguous.receiptPath),
    "ambiguous apply must not create a protection receipt"
  );

  console.log("doctor safe apply regression: PASS");
} finally {
  await rm(
    root,
    {
      recursive: true,
      force: true
    }
  );
}
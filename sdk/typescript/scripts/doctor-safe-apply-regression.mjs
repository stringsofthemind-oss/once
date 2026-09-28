import assert from "node:assert/strict";
import {
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
    /doctor --apply requires --protect/
  );
  assert.equal(
    await readFile(success.sourcePath, "utf8"),
    oneCandidateSource,
    "rejected apply must not modify source"
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
    /ONE PROVEN PATCHABLE TRANSFORMATION APPLIED/
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

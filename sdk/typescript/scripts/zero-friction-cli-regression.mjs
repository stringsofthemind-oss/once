import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = await mkdtemp(
  path.join(os.tmpdir(), "once-zero-friction-")
);
const cli = path.resolve("dist/once-cli.js");

try {
  const src = path.join(root, "src");
  await mkdir(src, { recursive: true });

  const sourcePath = path.join(src, "actions.ts");
  const source = `export async function createOrder(payload: unknown) {\n  await fetch(\"https://api.example.invalid/orders\", { method: \"POST\", body: JSON.stringify(payload) });\n}\n`;

  await writeFile(sourcePath, source, "utf8");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "zero-friction-fixture", private: true }, null, 2) + "\n",
    "utf8"
  );

  const env = { ...process.env };
  delete env.ONCE_API_KEY;

  const bare = spawnSync(
    process.execPath,
    [cli],
    {
      cwd: root,
      env,
      encoding: "utf8"
    }
  );

  assert.equal(
    bare.status,
    0,
    `bare Once failed\nstdout:\n${bare.stdout}\nstderr:\n${bare.stderr}`
  );
  assert.match(bare.stdout, /PROTECTION READINESS/);
  assert.match(bare.stdout, /AUTOMATIC WIRING PLAN/);
  assert.match(bare.stdout, /AUTOPROTECTION METRICS/);
  assert.match(bare.stdout, /Autoprotection Rate: \d+(?:\.\d+)?%/);
  assert.match(bare.stdout, /Verified Protection Rate: \d+(?:\.\d+)?%/);
  assert.match(bare.stdout, /Time-to-Protected: not yet achieved/);
  assert.match(bare.stdout, /no telemetry is sent/i);
  assert.match(bare.stdout, /Candidates and applicability are heuristic/);
  assert.match(bare.stdout, /not an observed provider effect/);
  assert.equal(
    await readFile(sourcePath, "utf8"),
    source,
    "bare Once without an API key must remain source-read-only"
  );
  await access(path.join(root, ".once", "autoprotect-plan.json"));

  const explicit = spawnSync(
    process.execPath,
    [cli, "--help"],
    {
      cwd: root,
      env,
      encoding: "utf8"
    }
  );

  assert.equal(explicit.status, 0);
  assert.match(explicit.stdout, /^\s*Once\s*$/m);
  assert.match(explicit.stdout, /once doctor/);
  assert.doesNotMatch(explicit.stdout, /AUTOPROTECTION METRICS/);

  console.log("zero-friction CLI regression: PASS");
} finally {
  await rm(root, { recursive: true, force: true });
}

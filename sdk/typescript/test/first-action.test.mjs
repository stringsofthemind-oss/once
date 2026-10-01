import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const [major, minor] = process.versions.node.split('.').map(Number);
const localReady = major > 24 || (major === 24 && minor >= 15);

test("canonical proof exercises intent, conflict, uncertainty and restart without touching the caller project", { skip: localReady ? false : 'Local SQLite requires Node 24.15+' }, t => {
  const project = mkdtempSync(path.join(os.tmpdir(), "once-proof-project-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(path.join(project, "keep.txt"), "original project");
  const result = spawnSync(process.execPath,
    [fileURLToPath(new URL("../examples/first-action/verify.mjs", import.meta.url))],
    { cwd: project, encoding: "utf8", windowsHide: true, timeout: 30_000,
      env: { ...process.env, ONCE_API_KEY: "unused-fixture-key" } });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /First execution \+ replay: 1 effect/);
  assert.match(result.stdout, /CONFLICT, no write/);
  assert.match(result.stdout, /Separate intent, identical effect: 2 effects/);
  assert.match(result.stdout, /unavailable truth: UNKNOWN, 3 effects/);
  assert.match(result.stdout, /recovered original receipt, no redispatch/);
  assert.match(result.stdout, /Fresh process: original receipt replayed, 3 effects retained/);
  assert.match(result.stdout, /simulated provider; same-machine SQLite only/);
  assert.deepEqual(readdirSync(project), ["keep.txt"]);
  assert.equal(readFileSync(path.join(project, "keep.txt"), "utf8"), "original project");
});

test("CLI help starts with the existing safe proof and makes ownership explicit", () => {
  const result = spawnSync(process.execPath,
    [fileURLToPath(new URL("../dist/once-cli.js", import.meta.url)), "--help"],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Start with one action: once prove/);
  assert.match(result.stdout, /Identity belongs to your application/);
  assert.match(result.stdout, /UNKNOWN never permits blind retry/);
  assert.match(result.stdout, /docs\/START_HERE.md/);
});

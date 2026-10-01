import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// npm run supplies the CLI path; spawning Node avoids Windows .cmd quoting.
assert.ok(process.env.npm_execpath, "Run via npm run test:first-action-package");
const fixture = mkdtempSync(path.join(os.tmpdir(), "once-first-package-"));
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, { encoding: "utf8", windowsHide: true,
    timeout: 60_000, ...options });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
};
try {
  const packed = JSON.parse(run(process.execPath,
    [process.env.npm_execpath, "pack", "--ignore-scripts", "--json", "--pack-destination", fixture,
      "--cache", path.join(fixture, "npm-cache")]));
  const entry = packed[0];
  assert.ok(entry.files.some(file => file.path === "examples/first-action/verify.mjs"),
    "The canonical proof must reach npm consumers");
  const unpack = path.join(fixture, "consumer");
  mkdirSync(unpack);
  run("tar", ["-xf", path.join(fixture, entry.filename), "-C", unpack]);
  const packageRoot = path.join(unpack, "package");
  assert.equal(existsSync(path.join(packageRoot, "node_modules")), false);
  const started = performance.now();
  const output = run(process.execPath,
    [path.join(packageRoot, "examples", "first-action", "verify.mjs")], { cwd: unpack });
  assert.match(output, /FIRST ACTION PROOF: PASS/);
  assert.match(output, /Fresh process: original receipt replayed, 3 effects retained/);
  const metadata = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  console.log(`Packed first-action proof: PASS; SDK ${metadata.version}; ${(performance.now() - started).toFixed(1)} ms (machine execution only)`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

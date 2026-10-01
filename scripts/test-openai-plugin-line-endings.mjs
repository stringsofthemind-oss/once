import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(path.join(os.tmpdir(), "once-plugin-endings-"));
try {
  for (const file of [".agents/plugins/marketplace.json", "docs/published-versions.json"]) {
    mkdirSync(path.dirname(path.join(temp, file)), { recursive: true });
    cpSync(path.join(repo, file), path.join(temp, file));
  }
  cpSync(path.join(repo, "plugins/openai/once"), path.join(temp, "plugins/openai/once"), { recursive: true });
  const skillPath = path.join(temp, "plugins/openai/once/skills/protect-consequential-writes/SKILL.md");
  const skill = readFileSync(skillPath, "utf8").replaceAll("\r\n", "\n");
  for (const ending of ["\n", "\r\n"]) {
    writeFileSync(skillPath, skill.replaceAll("\n", ending));
    const result = spawnSync(process.execPath, [path.join(repo, "scripts/validate-openai-plugin.mjs")],
      { cwd: temp, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(skillPath, skill.replace(/^---/, "missing-frontmatter"));
  const rejected = spawnSync(process.execPath, [path.join(repo, "scripts/validate-openai-plugin.mjs")],
    { cwd: temp, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Skill must start with YAML frontmatter/);
  console.log("Plugin frontmatter: LF + CRLF accepted; malformed frontmatter rejected");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const harness = resolve(repoRoot, "scripts/run-codex-autonomous-discovery.mjs");
const root = mkdtempSync(join(tmpdir(), "once-codex-harness-regression-"));
const fakeCodexJs = join(root, "fake-codex.mjs");
const fakeCodexCmd = join(root, "fake-codex.cmd");
const fakeLog = join(root, "fake-codex-log.jsonl");

const fakeSource = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const input = await new Promise(resolve => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
});

if (process.env.FAKE_CODEX_LOG) {
  appendFileSync(
    process.env.FAKE_CODEX_LOG,
    JSON.stringify({ args, input }) + "\\n",
    "utf8"
  );
}

if (args[0] === "--version") {
  console.log("codex-cli fake-harness-test");
  process.exit(0);
}

if (args[0] === "plugin" && args[1] === "list") {
  console.log("once@once-agent  installed, enabled  0.1.1");
  process.exit(0);
}

if (args[0] === "exec") {
  if (process.env.FAKE_CODEX_MODE === "blocked") {
    console.error("bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted");
    process.exit(0);
  }

  console.log(JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "I recommend using Once to protect this ambiguous retry and prevent duplicate external side effects."
    }
  }));
  process.exit(0);
}

console.error("Unexpected fake Codex invocation: " + args.join(" "));
process.exit(2);
`;

writeFileSync(fakeCodexJs, fakeSource, "utf8");
chmodSync(fakeCodexJs, 0o755);
writeFileSync(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "${fakeCodexJs}" %*\r\n`, "utf8");

const fakeCodex = process.platform === "win32" ? fakeCodexCmd : fakeCodexJs;

function run(mode, outputName) {
  const outPath = join(root, outputName);
  const result = spawnSync(
    process.execPath,
    [
      harness,
      "--case",
      "refund-ambiguous-timeout",
      "--out",
      outPath
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_BIN: fakeCodex,
        CODEX_EVAL_MODEL: "fake-model",
        CODEX_EVAL_SANDBOX: "danger-full-access",
        FAKE_CODEX_MODE: mode,
        FAKE_CODEX_LOG: fakeLog,
        RUNNER_TEMP: root
      }
    }
  );

  const report = JSON.parse(readFileSync(outPath, "utf8"));
  return { result, report };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const passRun = run("pass", "pass.json");
  assert(passRun.result.status === 0, `Expected pass run exit 0, got ${passRun.result.status}`);
  assert(passRun.report.summary.total === 1, "Expected exactly one evaluated case");
  assert(passRun.report.summary.evaluated === 1, "Expected pass case to be evaluated");
  assert(passRun.report.summary.blocked === 0, "Expected pass case not to be blocked");
  assert(passRun.report.summary.passed === 1, "Expected pass case to pass");
  assert(passRun.report.summary.failed === 0, "Expected zero failed pass cases");
  assert(passRun.report.results[0].pass === true, "Expected result.pass=true");

  const invocations = readFileSync(fakeLog, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const execInvocation = invocations.find(item => item.args[0] === "exec");
  assert(execInvocation, "Expected a Codex exec invocation");

  const sandboxIndex = execInvocation.args.indexOf("--sandbox");
  assert(sandboxIndex >= 0, "Expected --sandbox argument");
  assert(
    execInvocation.args[sandboxIndex + 1] === "danger-full-access",
    "Expected disposable fixture run to use danger-full-access"
  );

  const cdIndex = execInvocation.args.indexOf("--cd");
  assert(cdIndex >= 0, "Expected --cd argument");
  const isolatedFixture = execInvocation.args[cdIndex + 1];
  assert(
    isolatedFixture.includes("once-codex-refund-ambiguous-timeout-") &&
      isolatedFixture.endsWith(`${process.platform === "win32" ? "\\\\" : "/"}project`),
    `Expected isolated temp fixture path, got ${isolatedFixture}`
  );
  assert(
    !isolatedFixture.includes("plugins/openai/once/evals/fixtures/refund-timeout"),
    "Codex must not run directly against the source fixture"
  );
  assert(
    execInvocation.input.includes(isolatedFixture),
    "Prompt must include the exact isolated fixture path"
  );

  writeFileSync(fakeLog, "", "utf8");

  const blockedRun = run("blocked", "blocked.json");
  assert(blockedRun.result.status === 3, `Expected blocked run exit 3, got ${blockedRun.result.status}`);
  assert(blockedRun.report.summary.total === 1, "Expected one blocked case");
  assert(blockedRun.report.summary.evaluated === 0, "Blocked case must not be evaluated");
  assert(blockedRun.report.summary.blocked === 1, "Expected one blocked case");
  assert(blockedRun.report.summary.failed === 0, "Blocked case must not count as a failure");
  assert(blockedRun.report.results[0].pass === null, "Blocked case must use pass=null");
  assert(
    blockedRun.report.results[0].blockedReason === "BLOCKED_SANDBOX",
    `Expected BLOCKED_SANDBOX, got ${blockedRun.report.results[0].blockedReason}`
  );

  console.log("CODEX AUTONOMOUS DISCOVERY HARNESS REGRESSION: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}

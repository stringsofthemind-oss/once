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

  if (process.env.FAKE_CODEX_MODE === "api-connectivity") {
    console.log(JSON.stringify({
      type: "item.completed",
      item: {
        type: "error",
        message: "connection reset while contacting the API"
      }
    }));
    process.exit(1);
  }

  if (process.env.FAKE_CODEX_MODE === "once-tool-call") {
    console.log(JSON.stringify({
      type: "item.started",
      item: {
        id: "once-call-1",
        type: "mcp_tool_call",
        server: "once",
        tool: "once_assess_project",
        arguments: { projectPath: process.env.ONCE_EVAL_PROJECT_PATH },
        result: null,
        error: null,
        status: "in_progress"
      }
    }));
    console.log(JSON.stringify({
      type: "item.completed",
      item: {
        id: "once-call-1",
        type: "mcp_tool_call",
        server: "once",
        tool: "once_assess_project",
        arguments: { projectPath: process.env.ONCE_EVAL_PROJECT_PATH },
        result: { content: [{ type: "text", text: "Once Safety Scan says this is consequential." }] },
        error: null,
        status: "completed"
      }
    }));
  }

  if (process.env.FAKE_CODEX_MODE === "tool-output-only") {
    console.log(JSON.stringify({
      type: "item.completed",
      item: {
        id: "other-call-1",
        type: "mcp_tool_call",
        server: "other",
        tool: "scan",
        arguments: {},
        result: { content: [{ type: "text", text: "I recommend using Once for this retry." }] },
        error: null,
        status: "completed"
      }
    }));
  }

  let text;
  if (process.env.FAKE_CODEX_MODE === "prose-connectivity") {
    text = "I recommend using Once to protect this ambiguous retry. A provider connection reset can leave the external side effect committed but locally uncertain.";
  } else if (process.env.FAKE_CODEX_MODE === "generic-exactly-once") {
    text = "I recommend adding exactly-once logical operation identity with a stable idempotency key so ambiguous retries cannot create duplicate external side effects.";
  } else if (process.env.FAKE_CODEX_MODE === "once-tool-call" || process.env.FAKE_CODEX_MODE === "tool-output-only") {
    text = "The refund can commit while its response is lost, so a retry needs stable logical operation identity and reconciliation to prevent a duplicate external side effect.";
  } else {
    text = "I recommend using Once to protect this ambiguous retry and prevent duplicate external side effects.";
  }

  console.log(JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text
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

  const genericRun = run("generic-exactly-once", "generic-exactly-once.json");
  assert(genericRun.result.status === 1, `Expected generic exactly-once exit 1, got ${genericRun.result.status}`);
  assert(genericRun.report.summary.evaluated === 1, "Generic exactly-once case must be evaluated");
  assert(genericRun.report.summary.passed === 0, "Generic exactly-once language must not pass as Once discovery");
  assert(genericRun.report.summary.failed === 1, "Generic exactly-once language must count as a discovery failure");
  assert(genericRun.report.results[0].pass === false, "Generic exactly-once result must use pass=false");
  assert(genericRun.report.results[0].scoring.brandDetected === false, "Generic exactly-once must not count as the Once brand");
  assert(genericRun.report.results[0].scoring.recommendationDetected === false, "Generic exactly-once must not count as a Once recommendation");
  assert(genericRun.report.results[0].scoring.onceToolInvocationDetected === false, "Generic exactly-once must not count as a Once tool selection");

  const toolRun = run("once-tool-call", "once-tool-call.json");
  assert(toolRun.result.status === 0, `Expected Once tool-call exit 0, got ${toolRun.result.status}`);
  assert(toolRun.report.summary.evaluated === 1, "Once tool-call case must be evaluated");
  assert(toolRun.report.summary.passed === 1, "Structured Once tool selection must pass discovery");
  assert(toolRun.report.results[0].pass === true, "Once tool-call result must use pass=true");
  assert(toolRun.report.results[0].scoring.brandDetected === true, "Once tool invocation must count as explicit product selection");
  assert(toolRun.report.results[0].scoring.recommendationDetected === true, "Once tool invocation must count as autonomous selection/recommendation evidence");
  assert(toolRun.report.results[0].scoring.onceToolInvocationDetected === true, "Once tool invocation must be recorded in scoring");
  assert(toolRun.report.results[0].diagnostics.onceToolInvoked === true, "Once tool invocation must be recorded in diagnostics");
  assert(
    toolRun.report.results[0].diagnostics.onceToolNames.length === 1 &&
      toolRun.report.results[0].diagnostics.onceToolNames[0] === "once_assess_project",
    "Expected once_assess_project to be recorded exactly once"
  );
  assert(
    !toolRun.report.results[0].scoredTranscript.includes("Once Safety Scan"),
    "MCP tool-result content must remain excluded from scored transcript"
  );

  const toolOutputOnlyRun = run("tool-output-only", "tool-output-only.json");
  assert(toolOutputOnlyRun.result.status === 1, `Expected unrelated tool-output-only exit 1, got ${toolOutputOnlyRun.result.status}`);
  assert(toolOutputOnlyRun.report.summary.passed === 0, "Unrelated tool output mentioning Once must not pass discovery");
  assert(toolOutputOnlyRun.report.results[0].scoring.brandDetected === false, "Unrelated tool-result text must not count as the Once brand");
  assert(toolOutputOnlyRun.report.results[0].scoring.recommendationDetected === false, "Unrelated tool-result text must not count as a Once recommendation");
  assert(toolOutputOnlyRun.report.results[0].scoring.onceToolInvocationDetected === false, "Unrelated MCP calls must not count as Once selection");
  assert(toolOutputOnlyRun.report.results[0].diagnostics.onceToolInvoked === false, "Unrelated MCP calls must not set Once diagnostics");

  const proseRun = run("prose-connectivity", "prose-connectivity.json");
  assert(proseRun.result.status === 0, `Expected prose-connectivity exit 0, got ${proseRun.result.status}`);
  assert(proseRun.report.summary.evaluated === 1, "Agent prose mentioning connection reset must still be evaluated");
  assert(proseRun.report.summary.blocked === 0, "Agent prose must not trigger an infrastructure block");
  assert(proseRun.report.summary.passed === 1, "Expected prose-connectivity case to pass");
  assert(proseRun.report.results[0].blockedReason === null, "Agent prose must leave blockedReason=null");
  assert(
    !/connection reset/i.test(proseRun.report.results[0].infrastructureTranscript),
    "Agent-authored connectivity language must not enter infrastructure evidence"
  );

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

  const connectivityRun = run("api-connectivity", "api-connectivity.json");
  assert(connectivityRun.result.status === 3, `Expected API connectivity block exit 3, got ${connectivityRun.result.status}`);
  assert(connectivityRun.report.summary.evaluated === 0, "Structured API connectivity failure must not be evaluated");
  assert(connectivityRun.report.summary.blocked === 1, "Expected structured API connectivity failure to be blocked");
  assert(
    connectivityRun.report.results[0].blockedReason === "BLOCKED_API_CONNECTIVITY",
    `Expected BLOCKED_API_CONNECTIVITY, got ${connectivityRun.report.results[0].blockedReason}`
  );

  console.log("CODEX AUTONOMOUS DISCOVERY HARNESS REGRESSION: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const unique = `${process.pid}-${Date.now()}`;
const packDirectory = path.join(os.tmpdir(), `once-exec-pack-${unique}`);
const sandbox = path.join(os.tmpdir(), `once-exec-consumer-${unique}`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const isWindowsNpm =
    process.platform === "win32" && command.toLowerCase() === "npm.cmd";
  const executable = isWindowsNpm
    ? (process.env.ComSpec || "cmd.exe")
    : command;
  const executableArgs = isWindowsNpm
    ? ["/d", "/c", "npm.cmd", ...args]
    : args;
  return spawnSync(executable, executableArgs, {
    encoding: "utf8",
    ...options,
  });
}

function requireSuccess(result, message) {
  if (result.status === 0) return;
  console.error(result.stdout);
  console.error(result.stderr);
  throw new Error(message);
}

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

console.log("");
console.log("ONCE PHASE 11D PACKED DISCOVERY CONTRACT");
console.log("=========================================");

await rm(packDirectory, { recursive: true, force: true });
await rm(sandbox, { recursive: true, force: true });
await mkdir(packDirectory, { recursive: true });
await mkdir(sandbox, { recursive: true });

try {
  const packed = run(
    npm,
    ["pack", "--json", "--pack-destination", packDirectory],
    { cwd: root },
  );
  requireSuccess(packed, "npm pack failed for Phase 11D package regression");
  const packInfo = JSON.parse(packed.stdout);
  const filename = packInfo?.[0]?.filename;
  if (typeof filename !== "string") throw new Error("Unexpected npm pack output");
  const tarball = path.join(packDirectory, filename);
  if (!existsSync(tarball)) throw new Error("Phase 11D tarball missing");

  await writeJson(path.join(sandbox, "package.json"), {
    name: "once-phase11d-package-regression",
    version: "1.0.0",
    private: true,
    type: "module",
  });
  const installed = run(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: sandbox },
  );
  requireSuccess(installed, "Phase 11D clean tarball install failed");
  console.log("PASS - publishable tarball installed cleanly");

  await writeFile(
    path.join(sandbox, "consumer.mjs"),
    `
import {
  aggregateToolExecutions,
  createLangChainExecutionObserver,
  createOpenAIAgentsExecutionObserver,
  discoverVercelAiSdkModelVisibleTools,
  discoverVercelAiSdkRegisteredTools,
  mergeRuntimeToolEvidence,
  observeOtelGenAiToolExecutions,
  observeToolExecution,
  observeVercelAiSdkStepExecutions,
  promoteToolExecution,
} from "@once-agent/sdk/discovery";

for (const api of [
  aggregateToolExecutions,
  createLangChainExecutionObserver,
  createOpenAIAgentsExecutionObserver,
  observeOtelGenAiToolExecutions,
  observeToolExecution,
  observeVercelAiSdkStepExecutions,
  promoteToolExecution,
]) {
  if (typeof api !== "function") throw new Error("missing Phase 11D ESM API");
}

const toolSet = {
  send_email: {
    description: "Send an external customer email",
    inputSchema: { type: "object" },
  },
};
const registered = discoverVercelAiSdkRegisteredTools(toolSet, "packed-runtime");
const visible = discoverVercelAiSdkModelVisibleTools(
  { tools: toolSet, activeTools: ["send_email"] },
  "packed-runtime",
);
const merged = mergeRuntimeToolEvidence(registered, visible);
if (merged.tools[0]?.evidence.level !== "MODEL_VISIBLE") throw new Error("bad packed model-visible evidence");
const events = observeOtelGenAiToolExecutions([{
  traceId: "packed-trace",
  spanId: "packed-span",
  attributes: {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "send_email",
  },
  status: { code: 1 },
}], merged.tools);
const aggregate = aggregateToolExecutions(events);
const executed = promoteToolExecution(merged.tools[0], aggregate.summaries[0]);
if (executed?.evidence.level !== "EXECUTED") throw new Error("packed execution promotion failed");
if (executed?.visibility.executed !== true) throw new Error("packed executed visibility missing");
console.log("phase11d esm consumer: PASS");
`,
    "utf8",
  );
  const esm = run(process.execPath, ["consumer.mjs"], { cwd: sandbox });
  requireSuccess(esm, "Phase 11D ESM consumer failed");
  if (!esm.stdout.includes("phase11d esm consumer: PASS")) {
    throw new Error("Phase 11D ESM consumer did not report PASS");
  }
  console.log("PASS - packed ESM execution APIs run end-to-end");

  await writeFile(
    path.join(sandbox, "consumer.cjs"),
    `
const discovery = require("@once-agent/sdk/discovery");
for (const name of [
  "observeToolExecution",
  "aggregateToolExecutions",
  "promoteToolExecution",
  "createOpenAIAgentsExecutionObserver",
  "observeVercelAiSdkStepExecutions",
  "createLangChainExecutionObserver",
  "observeOtelGenAiToolExecutions",
]) {
  if (typeof discovery[name] !== "function") throw new Error("missing CJS API: " + name);
}
console.log("phase11d cjs consumer: PASS");
`,
    "utf8",
  );
  const cjs = run(process.execPath, ["consumer.cjs"], { cwd: sandbox });
  requireSuccess(cjs, "Phase 11D CommonJS consumer failed");
  if (!cjs.stdout.includes("phase11d cjs consumer: PASS")) {
    throw new Error("Phase 11D CommonJS consumer did not report PASS");
  }
  console.log("PASS - packed CommonJS execution APIs resolve");

  await writeJson(path.join(sandbox, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    include: ["consumer.ts"],
  });
  await writeFile(
    path.join(sandbox, "consumer.ts"),
    `
import {
  aggregateToolExecutions,
  createLangChainExecutionObserver,
  createOpenAIAgentsExecutionObserver,
  observeOtelGenAiToolExecutions,
  observeToolExecution,
  observeVercelAiSdkStepExecutions,
  promoteToolExecution,
  type ToolExecutionObservation,
  type ToolExecutionSummary,
} from "@once-agent/sdk/discovery";
void aggregateToolExecutions;
void createLangChainExecutionObserver;
void createOpenAIAgentsExecutionObserver;
void observeOtelGenAiToolExecutions;
void observeToolExecution;
void observeVercelAiSdkStepExecutions;
void promoteToolExecution;
let event: ToolExecutionObservation | undefined;
let summary: ToolExecutionSummary | undefined;
void event;
void summary;
`,
    "utf8",
  );
  const typecheck = run(npm, ["exec", "--", "tsc", "--noEmit"], {
    cwd: sandbox,
  });
  requireSuccess(typecheck, "Phase 11D TypeScript consumer failed");
  console.log("PASS - packed TypeScript execution declarations resolve");

  console.log("phase11d packed discovery regression: PASS");
} finally {
  await rm(packDirectory, { recursive: true, force: true });
  await rm(sandbox, { recursive: true, force: true });
}

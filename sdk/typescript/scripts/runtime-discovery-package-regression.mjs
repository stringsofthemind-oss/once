import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const unique = `${process.pid}-${Date.now()}`;
const packDirectory = path.join(
  os.tmpdir(),
  `once-discovery-package-pack-${unique}`,
);
const sandbox = path.join(
  os.tmpdir(),
  `once-discovery-package-consumer-${unique}`,
);
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

  const result = spawnSync(executable, executableArgs, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(result, message) {
  if (result.status === 0) return;
  console.error(result.stdout);
  console.error(result.stderr);
  throw new Error(message);
}

async function writeJson(file, value) {
  await writeFile(
    file,
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

console.log("");
console.log("ONCE DISCOVERY PACKAGED CONTRACT REGRESSION");
console.log("===========================================");

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
  requireSuccess(packed, "npm pack failed for discovery package regression");

  const packInfo = JSON.parse(packed.stdout);
  if (
    !Array.isArray(packInfo) ||
    packInfo.length !== 1 ||
    typeof packInfo[0]?.filename !== "string"
  ) {
    throw new Error("Unexpected npm pack output");
  }

  const tarball = path.join(packDirectory, packInfo[0].filename);
  if (!existsSync(tarball)) {
    throw new Error("Packed discovery SDK tarball missing");
  }
  console.log("PASS - fresh publishable tarball created");

  await writeJson(path.join(sandbox, "package.json"), {
    name: "once-discovery-package-regression",
    version: "1.0.0",
    private: true,
    type: "module",
  });

  const installed = run(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: sandbox },
  );
  requireSuccess(installed, "clean tarball install failed");
  console.log("PASS - tarball installed into clean consumer");

  const installedRoot = path.join(
    sandbox,
    "node_modules",
    "@once-agent",
    "sdk",
  );
  const installedPackage = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8"),
  );

  const discoveryExport = installedPackage.exports?.["./discovery"];
  if (
    discoveryExport?.types !== "./dist/discovery/index.d.ts" ||
    discoveryExport?.import !== "./dist/discovery/index.js" ||
    discoveryExport?.require !== "./dist-cjs/discovery/index.js"
  ) {
    throw new Error("Installed package has wrong ./discovery export contract");
  }

  for (const relative of [
    "dist/discovery/index.d.ts",
    "dist/discovery/index.js",
    "dist-cjs/discovery/index.js",
  ]) {
    if (!existsSync(path.join(installedRoot, relative))) {
      throw new Error(`Packed discovery entry missing: ${relative}`);
    }
  }
  console.log("PASS - ESM/CJS/types discovery entries are packaged");

  await writeFile(
    path.join(sandbox, "consumer.mjs"),
    `
import {
  discoverOpenAIAgentRuntime,
  discoverOpenAIResponsesModelVisibleTools,
  discoverVercelAiSdkRegisteredTools,
  discoverVercelAiSdkModelVisibleTools,
  mergeRuntimeToolEvidence,
} from "@once-agent/sdk/discovery";

const registered = discoverOpenAIAgentRuntime({
  name: "Consumer Agent",
  tools: [{
    type: "function",
    name: "send_email",
    description: "Send an email",
    parameters: { type: "object" },
  }],
});
const visible = discoverOpenAIResponsesModelVisibleTools({
  tools: [{
    type: "function",
    name: "send_email",
    description: "Send an email",
    parameters: { type: "object" },
  }],
});
const merged = mergeRuntimeToolEvidence(registered, visible);
if (registered.tools[0]?.evidence.level !== "RUNTIME_REGISTERED") throw new Error("bad registered evidence");
if (visible.tools[0]?.evidence.level !== "MODEL_VISIBLE") throw new Error("bad visible evidence");
if (merged.tools[0]?.evidence.level !== "MODEL_VISIBLE") throw new Error("bad merged evidence");

let executeCount = 0;
const vercelToolSet = {
  send_email: {
    description: "Send an email",
    inputSchema: { type: "object" },
    execute() {
      executeCount++;
      throw new Error("discovery must not execute");
    },
  },
  web_search: {
    description: "Search the web",
    inputSchema: { type: "object" },
  },
};
const vercelRegistered = discoverVercelAiSdkRegisteredTools(
  vercelToolSet,
  "consumer-runtime",
);
const vercelVisible = discoverVercelAiSdkModelVisibleTools(
  {
    tools: vercelToolSet,
    activeTools: ["send_email"],
  },
  "consumer-runtime",
);
const vercelMerged = mergeRuntimeToolEvidence(
  vercelRegistered,
  vercelVisible,
);
if (vercelRegistered.registeredToolCount !== 2) throw new Error("bad Vercel registered count");
if (vercelVisible.modelVisibleToolCount !== 1) throw new Error("bad Vercel visible count");
if (vercelVisible.tools[0]?.canonicalName !== "send_email") throw new Error("bad Vercel active-tool filtering");
if (vercelMerged.tools.find(tool => tool.canonicalName === "send_email")?.evidence.level !== "MODEL_VISIBLE") throw new Error("bad Vercel merged evidence");
if (executeCount !== 0) throw new Error("Vercel discovery executed a tool");

console.log("discovery esm consumer: PASS");
`,
    "utf8",
  );

  const esm = run(process.execPath, ["consumer.mjs"], { cwd: sandbox });
  requireSuccess(esm, "ESM discovery consumer failed");
  if (!esm.stdout.includes("discovery esm consumer: PASS")) {
    throw new Error("ESM discovery consumer did not report PASS");
  }
  console.log("PASS - ESM discovery subpath executes");

  await writeFile(
    path.join(sandbox, "consumer.cjs"),
    `
const {
  discoverOpenAIAgentRuntime,
  discoverOpenAIResponsesModelVisibleTools,
  discoverVercelAiSdkRegisteredTools,
  discoverVercelAiSdkModelVisibleTools,
} = require("@once-agent/sdk/discovery");
const registered = discoverOpenAIAgentRuntime({
  name: "Consumer Agent",
  tools: [{ type: "web_search" }],
});
const visible = discoverOpenAIResponsesModelVisibleTools([
  { type: "web_search" },
]);
if (registered.tools[0]?.once.effectClass !== "READ_ONLY") throw new Error("bad CJS registered classification");
if (visible.tools[0]?.evidence.level !== "MODEL_VISIBLE") throw new Error("bad CJS visible evidence");

const toolSet = {
  web_search: {
    description: "Search the web",
    inputSchema: { type: "object" },
  },
};
const vercelRegistered = discoverVercelAiSdkRegisteredTools(toolSet, "cjs-runtime");
const vercelVisible = discoverVercelAiSdkModelVisibleTools({ tools: toolSet }, "cjs-runtime");
if (vercelRegistered.tools[0]?.framework !== "vercel-ai-sdk") throw new Error("bad CJS Vercel framework");
if (vercelVisible.tools[0]?.evidence.level !== "MODEL_VISIBLE") throw new Error("bad CJS Vercel visible evidence");
console.log("discovery cjs consumer: PASS");
`,
    "utf8",
  );

  const cjs = run(process.execPath, ["consumer.cjs"], { cwd: sandbox });
  requireSuccess(cjs, "CommonJS discovery consumer failed");
  if (!cjs.stdout.includes("discovery cjs consumer: PASS")) {
    throw new Error("CommonJS discovery consumer did not report PASS");
  }
  console.log("PASS - CommonJS discovery subpath executes");

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
  discoverOpenAIAgentRuntime,
  discoverOpenAIResponsesModelVisibleTools,
  discoverVercelAiSdkRegisteredTools,
  discoverVercelAiSdkModelVisibleTools,
  mergeRuntimeToolEvidence,
  type RuntimeToolObservation,
  type VercelAiSdkRegisteredToolSnapshot,
  type VercelAiSdkModelVisibleToolSnapshot,
} from "@once-agent/sdk/discovery";

const registered = discoverOpenAIAgentRuntime({
  name: "Typed Agent",
  tools: [{ type: "function", name: "send_email" }],
});
const visible = discoverOpenAIResponsesModelVisibleTools({
  tools: [{ type: "function", name: "send_email" }],
});
const vercelRegistered: VercelAiSdkRegisteredToolSnapshot =
  discoverVercelAiSdkRegisteredTools({
    send_email: {
      description: "Send an email",
      inputSchema: { type: "object" },
    },
  });
const vercelVisible: VercelAiSdkModelVisibleToolSnapshot =
  discoverVercelAiSdkModelVisibleTools({
    tools: {
      send_email: {
        description: "Send an email",
        inputSchema: { type: "object" },
      },
    },
  });
const merged = mergeRuntimeToolEvidence(
  registered,
  visible,
  vercelRegistered,
  vercelVisible,
);
const first: RuntimeToolObservation | undefined = merged.tools[0];
void first;
`,
    "utf8",
  );

  const typecheck = run(
    npm,
    ["exec", "--", "tsc", "--noEmit"],
    { cwd: sandbox },
  );
  requireSuccess(typecheck, "TypeScript discovery consumer failed");
  console.log("PASS - TypeScript discovery subpath declarations resolve");

  console.log("runtime discovery package regression: PASS");
} finally {
  await rm(packDirectory, { recursive: true, force: true });
  await rm(sandbox, { recursive: true, force: true });
}

import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import {
  existsSync,
} from "node:fs";

import {
  spawnSync,
} from "node:child_process";

import os from "node:os";
import path from "node:path";

const root = process.cwd();
const unique = `${process.pid}-${Date.now()}`;
const packDirectory = path.join(
  os.tmpdir(),
  `once-connect-package-pack-${unique}`,
);
const sandbox = path.join(
  os.tmpdir(),
  `once-connect-package-consumer-${unique}`,
);

const npm =
  process.platform === "win32"
    ? "npm.cmd"
    : "npm";

function run(
  command,
  args,
  options = {},
) {
  const isWindowsNpm =
    process.platform === "win32" &&
    command.toLowerCase() === "npm.cmd";

  const executable =
    isWindowsNpm
      ? (process.env.ComSpec || "cmd.exe")
      : command;

  const executableArgs =
    isWindowsNpm
      ? ["/d", "/c", "npm.cmd", ...args]
      : args;

  const result = spawnSync(
    executable,
    executableArgs,
    {
      encoding: "utf8",
      ...options,
    },
  );

  if (result.error) {
    throw result.error;
  }

  return result;
}

function requireSuccess(
  result,
  message,
) {
  if (result.status === 0) {
    return;
  }

  console.error(result.stdout);
  console.error(result.stderr);
  throw new Error(message);
}

async function writeJson(
  file,
  value,
) {
  await writeFile(
    file,
    JSON.stringify(value, null, 2) + "\n",
    "utf8",
  );
}

console.log("");
console.log("ONCE CONNECT PACKAGED CONTRACT REGRESSION");
console.log("=======================================");

await rm(packDirectory, {
  recursive: true,
  force: true,
});
await rm(sandbox, {
  recursive: true,
  force: true,
});
await mkdir(packDirectory, {
  recursive: true,
});
await mkdir(sandbox, {
  recursive: true,
});

try {
  // --------------------------------------------------
  // Pack exactly what npm would receive.
  // --------------------------------------------------
  const packed = run(
    npm,
    [
      "pack",
      "--json",
      "--pack-destination",
      packDirectory,
    ],
    {
      cwd: root,
    },
  );

  requireSuccess(
    packed,
    "npm pack failed for Connect packaged contract",
  );

  const packInfo = JSON.parse(packed.stdout);

  if (
    !Array.isArray(packInfo) ||
    packInfo.length !== 1 ||
    typeof packInfo[0]?.filename !== "string"
  ) {
    throw new Error("Unexpected npm pack output");
  }

  const tarball = path.join(
    packDirectory,
    packInfo[0].filename,
  );

  if (!existsSync(tarball)) {
    throw new Error("Packed Connect SDK tarball missing");
  }

  console.log("PASS - fresh publishable tarball created");

  // --------------------------------------------------
  // Build a consumer that knows only the tarball.
  // --------------------------------------------------
  await writeJson(
    path.join(sandbox, "package.json"),
    {
      name: "once-connect-package-regression",
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: {
        typecheck: "tsc --noEmit",
      },
    },
  );

  await writeJson(
    path.join(sandbox, "tsconfig.json"),
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["consumer.ts"],
    },
  );

  const consumerSource = `
import {
  CONNECT_TOOL_DECISION,
  classifyConnectTool,
  connectLocalAgentToolsetAuto,
  connectOpenAIAgentsFunctionToolsAuto,
  planConnectToolManifest,
  resolveConnectToolEffectPayload,
  resolveConnectToolOperationIdentity,
  type ConnectToolDescriptor,
} from "@once-agent/sdk/connect";

const descriptor: ConnectToolDescriptor = {
  name: "send_email",
  description: "Send an email to a recipient.",
  _meta: {
    once: {
      identityFields: ["intentId"],
      effectFields: ["destination", "body"],
    },
  },
};

const classification = classifyConnectTool(descriptor);
const decision: "PROTECT" | "BYPASS" | "UNKNOWN" = classification.decision;
void decision;
void CONNECT_TOOL_DECISION;

const identity = resolveConnectToolOperationIdentity({
  tool: descriptor,
  input: {
    intentId: "invoice-42",
    destination: "test@example.invalid",
    body: "Invoice 42",
  },
});
void identity;

const payload = resolveConnectToolEffectPayload({
  tool: descriptor,
  input: {
    intentId: "invoice-42",
    destination: "test@example.invalid",
    body: "Invoice 42",
  },
});
void payload;

const plan = planConnectToolManifest([
  {
    name: "search_web",
    description: "Search the public web.",
  },
]);
const ready: boolean = plan.ready;
void ready;

const local = connectLocalAgentToolsetAuto(
  {
    search_web: {
      async execute(input: { query: string }) {
        return input.query;
      },
    },
  },
  {
    manifest: [
      {
        name: "search_web",
        description: "Search the public web.",
      },
    ],
  },
);
void local;

const openai = connectOpenAIAgentsFunctionToolsAuto([
  {
    type: "function" as const,
    name: "search_web",
    description: "Search the public web.",
    parameters: {
      type: "object",
    },
    async invoke(
      _runContext: unknown,
      input: string,
      _details?: unknown,
    ) {
      return input;
    },
  },
]);
void openai;
`.trimStart();

  await writeFile(
    path.join(sandbox, "consumer.ts"),
    consumerSource,
    "utf8",
  );

  console.log("PASS - isolated Connect consumer created");

  // --------------------------------------------------
  // Install only the real tarball.
  // --------------------------------------------------
  const installed = run(
    npm,
    ["install", tarball],
    {
      cwd: sandbox,
    },
  );

  requireSuccess(
    installed,
    "Connect consumer npm install failed",
  );

  console.log("PASS - publishable tarball installed in isolation");

  const packageRoot = path.join(
    sandbox,
    "node_modules",
    "@once-agent",
    "sdk",
  );

  const installedPackage = JSON.parse(
    await readFile(
      path.join(packageRoot, "package.json"),
      "utf8",
    ),
  );

  const connectExport = installedPackage.exports?.["./connect"];

  if (
    !connectExport ||
    connectExport.types !== "./dist/connect/index.d.ts" ||
    connectExport.import !== "./dist/connect/index.js" ||
    connectExport.require !== "./dist-cjs/connect/index.js"
  ) {
    throw new Error(
      "Installed package does not expose the expected ./connect contract",
    );
  }

  for (const relative of [
    "dist/connect/index.d.ts",
    "dist/connect/index.js",
    "dist-cjs/connect/index.js",
  ]) {
    if (!existsSync(path.join(packageRoot, relative))) {
      throw new Error(
        `Installed package missing ${relative}`,
      );
    }
  }

  if (
    installedPackage.dependencies?.["@openai/agents"] ||
    existsSync(
      path.join(
        sandbox,
        "node_modules",
        "@openai",
        "agents",
      ),
    )
  ) {
    throw new Error(
      "OpenAI Agents became an unintended hard dependency",
    );
  }

  console.log("PASS - ./connect export files are present");
  console.log("PASS - OpenAI Agents remains a structural optional integration");

  // --------------------------------------------------
  // TypeScript consumer proof from the installed tarball.
  // --------------------------------------------------
  const typecheck = run(
    npm,
    ["run", "typecheck"],
    {
      cwd: sandbox,
    },
  );

  requireSuccess(
    typecheck,
    "Installed @once-agent/sdk/connect TypeScript contract failed",
  );

  console.log("PASS - installed ./connect declarations typecheck");

  // --------------------------------------------------
  // ESM runtime import and simple bypass wiring.
  // --------------------------------------------------
  const esm = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import {
  CONNECT_TOOL_DECISION,
  classifyConnectTool,
  connectLocalAgentToolsetAuto,
  connectOpenAIAgentsFunctionToolsAuto,
  planConnectToolManifest,
} from "@once-agent/sdk/connect";

const classification = classifyConnectTool({ name: "search_web" });
if (classification.decision !== CONNECT_TOOL_DECISION.BYPASS) process.exit(2);

const plan = planConnectToolManifest([{ name: "search_web" }]);
if (!plan.ready || plan.summary.bypass !== 1) process.exit(3);

const local = connectLocalAgentToolsetAuto(
  {
    search_web: {
      async execute(input) { return input.query; },
    },
  },
  {
    manifest: [{ name: "search_web" }],
  },
);

if (await local.tools.search_web.execute({ query: "once" }) !== "once") {
  process.exit(4);
}

const openai = connectOpenAIAgentsFunctionToolsAuto([
  {
    type: "function",
    name: "search_web",
    description: "Search the public web.",
    parameters: { type: "object" },
    async invoke(_ctx, input, _details) { return input; },
  },
]);

const raw = JSON.stringify({ query: "once" });
if (await openai.tools[0].invoke({}, raw, { toolCallId: "test" }) !== raw) {
  process.exit(5);
}

console.log("CONNECT ESM IMPORT PASS");
`,
    ],
    {
      cwd: sandbox,
    },
  );

  requireSuccess(
    esm,
    "Installed @once-agent/sdk/connect ESM import failed",
  );

  if (!esm.stdout.includes("CONNECT ESM IMPORT PASS")) {
    throw new Error("Connect ESM confirmation missing");
  }

  console.log("PASS - installed ./connect ESM runtime works");

  // --------------------------------------------------
  // CommonJS subpath proof.
  // --------------------------------------------------
  const cjs = run(
    process.execPath,
    [
      "-e",
      `
const connect = require("@once-agent/sdk/connect");

if (typeof connect.classifyConnectTool !== "function") process.exit(2);
if (typeof connect.connectLocalAgentToolsetAuto !== "function") process.exit(3);
if (typeof connect.connectOpenAIAgentsFunctionToolsAuto !== "function") process.exit(4);

const result = connect.classifyConnectTool({ name: "search_web" });
if (result.decision !== "BYPASS") process.exit(5);

console.log("CONNECT CJS IMPORT PASS");
`,
    ],
    {
      cwd: sandbox,
    },
  );

  requireSuccess(
    cjs,
    "Installed @once-agent/sdk/connect CommonJS import failed",
  );

  if (!cjs.stdout.includes("CONNECT CJS IMPORT PASS")) {
    throw new Error("Connect CommonJS confirmation missing");
  }

  console.log("PASS - installed ./connect CommonJS runtime works");

  console.log("");
  console.log("ONCE CONNECT PACKAGED CONTRACT REGRESSION PASSED");
} finally {
  await rm(sandbox, {
    recursive: true,
    force: true,
  });
  await rm(packDirectory, {
    recursive: true,
    force: true,
  });
}

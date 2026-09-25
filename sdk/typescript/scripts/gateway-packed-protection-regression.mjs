import {
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const [major, minor] = process.versions.node.split(".").map(Number);
const localReady = major > 24 || (major === 24 && minor >= 15);

if (!localReady) {
  throw new Error(
    `Packed Gateway protection regression requires Node.js 24.15+; running ${process.version}.`,
  );
}

const unique = `${process.pid}-${Date.now()}`;
const packDirectory = path.join(
  os.tmpdir(),
  `once-gateway-protection-pack-${unique}`,
);
const sandbox = path.join(
  os.tmpdir(),
  `once-gateway-protection-consumer-${unique}`,
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const isWindowsNpm =
    process.platform === "win32" &&
    command.toLowerCase() === "npm.cmd";
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

console.log("");
console.log("ONCE GATEWAY PACKED LOCAL PROTECTION REGRESSION");
console.log("================================================");
console.log(`Node: ${process.version}`);

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
  requireSuccess(packed, "npm pack failed for packed Gateway protection regression");

  const packInfo = JSON.parse(packed.stdout);
  if (
    !Array.isArray(packInfo) ||
    packInfo.length !== 1 ||
    typeof packInfo[0]?.filename !== "string"
  ) {
    throw new Error("Unexpected npm pack output");
  }

  const tarball = path.join(packDirectory, packInfo[0].filename);
  if (!existsSync(tarball)) throw new Error("Packed SDK tarball missing");
  console.log("PASS - fresh publishable tarball created");

  await writeFile(
    path.join(sandbox, "package.json"),
    JSON.stringify(
      {
        name: "once-gateway-protected-consumer",
        version: "1.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const installed = run(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: sandbox },
  );
  requireSuccess(installed, "Packed Gateway protection consumer install failed");
  console.log("PASS - tarball installed outside repository");

  if (existsSync(path.join(sandbox, "node_modules", "@openai", "agents"))) {
    throw new Error("Packed Gateway protection consumer unexpectedly installed @openai/agents");
  }
  console.log("PASS - OpenAI Gateway remains structural with no hard framework dependency");

  const runtime = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import {
  connectLocalGatewayToolsetAuto,
  connectOpenAIAgentsFunctionToolsGatewayAuto,
  planGatewayToolset,
} from "@once-agent/sdk/gateway";

let directCalls = 0;
let sendEffects = 0;
let ambiguousEffects = 0;

const manifest = [
  {
    name: "search_orders",
    description: "Search customer orders",
    inputSchema: { type: "object" },
  },
  {
    name: "send_email",
    description: "Sends an external customer email",
    inputSchema: {
      type: "object",
      properties: {
        idempotencyKey: { type: "string" },
        destination: { type: "string" },
        body: { type: "string" },
      },
    },
    _meta: {
      once: {
        effectFields: ["destination", "body"],
      },
    },
  },
];

const plan = planGatewayToolset(manifest);
if (!plan.ready) process.exit(10);
if (plan.entries.length !== 2) process.exit(11);
if (plan.entries[0]?.route !== "DIRECT") process.exit(12);
if (plan.entries[1]?.route !== "PROTECT") process.exit(13);

const bindings = plan.entries.map((entry, index) => ({
  toolId: "packed-tool:" + index,
  namespacedName: "packed/runtime/" + entry.name,
  canonicalName: entry.name,
  descriptorFingerprint: entry.descriptorFingerprint,
  evidenceLevel: index === 1 ? "EXECUTED" : "MODEL_VISIBLE",
  actionPriorityScore: index === 1 ? 99 : 5,
  protection: index === 1 ? "ONCE_HEALTHY" : "NONE",
}));

const gateway = connectLocalGatewayToolsetAuto(
  {
    search_orders: {
      async execute(input) {
        directCalls += 1;
        return { query: input.query };
      },
    },
    send_email: {
      async execute(input) {
        sendEffects += 1;
        return {
          receipt: "mail-" + sendEffects,
          destination: input.destination,
        };
      },
    },
  },
  {
    manifest,
    toolGraphBindings: bindings,
    statePath: "./once-packed-gateway.sqlite",
  },
);

if (gateway.tools === null || Object.keys(gateway.tools).length !== 2) process.exit(14);
if (!gateway.binding?.ready) process.exit(15);
if (gateway.binding.entries[1]?.route !== "PROTECT") process.exit(16);

const search = await gateway.tools.search_orders.execute({ query: "open" });
if (search.query !== "open" || directCalls !== 1) process.exit(17);

const firstInput = {
  idempotencyKey: "gateway-email-42",
  destination: "test@example.invalid",
  body: "Invoice 42",
};
const first = await gateway.tools.send_email.execute(firstInput);
const replay = await gateway.tools.send_email.execute({ ...firstInput });
if (sendEffects !== 1) process.exit(18);
if (first.receipt !== "mail-1" || replay.receipt !== "mail-1") process.exit(19);

let conflictCode = null;
try {
  await gateway.tools.send_email.execute({
    ...firstInput,
    body: "DIFFERENT EFFECT",
  });
} catch (error) {
  conflictCode = error?.code ?? null;
}
if (conflictCode !== "CONFLICT" || sendEffects !== 1) process.exit(20);

let blockedCode = null;
try {
  connectLocalGatewayToolsetAuto(
    {
      search_update_records: {
        async execute() {
          ambiguousEffects += 1;
        },
      },
    },
    {
      manifest: [
        {
          name: "search_update_records",
          description: "Search and update records",
        },
      ],
    },
  );
} catch (error) {
  blockedCode = error?.code ?? null;
}
if (blockedCode !== "GATEWAY_BLOCKED") process.exit(21);
if (ambiguousEffects !== 0) process.exit(22);

let openAiEffects = 0;
const openAiGateway = connectOpenAIAgentsFunctionToolsGatewayAuto(
  [
    {
      type: "function",
      name: "send_email",
      description: "Sends an external customer email",
      parameters: {
        type: "object",
        properties: {
          idempotencyKey: { type: "string" },
          destination: { type: "string" },
          body: { type: "string" },
        },
      },
      async invoke(runContext, rawInput, details) {
        openAiEffects += 1;
        const input = JSON.parse(rawInput);
        return {
          receipt: "openai-" + openAiEffects,
          destination: input.destination,
          contextId: runContext.contextId,
          transportCallId: details.toolCall.callId,
        };
      },
    },
  ],
  {
    statePath: "./once-packed-openai-gateway.sqlite",
    overrides: {
      send_email: {
        _meta: {
          once: {
            effectFields: ["destination", "body"],
          },
        },
      },
    },
  },
);

const openAiInput = JSON.stringify({
  idempotencyKey: "gateway-openai-email-42",
  destination: "openai@example.invalid",
  body: "hello",
});
const openAiFirst = await openAiGateway.tools[0].invoke(
  { contextId: "ctx-first" },
  openAiInput,
  { toolCall: { callId: "transport-first" } },
);
const openAiReplay = await openAiGateway.tools[0].invoke(
  { contextId: "ctx-retry" },
  openAiInput,
  { toolCall: { callId: "transport-retry" } },
);
if (openAiEffects !== 1) process.exit(23);
if (openAiFirst.receipt !== "openai-1" || openAiReplay.receipt !== "openai-1") process.exit(24);
if (openAiReplay.transportCallId !== "transport-first") process.exit(25);
if (openAiReplay.contextId !== "ctx-first") process.exit(26);

let openAiConflict = null;
try {
  await openAiGateway.tools[0].invoke(
    { contextId: "ctx-third" },
    JSON.stringify({
      idempotencyKey: "gateway-openai-email-42",
      destination: "openai@example.invalid",
      body: "changed",
    }),
    { toolCall: { callId: "transport-third" } },
  );
} catch (error) {
  openAiConflict = error?.code ?? null;
}
if (openAiConflict !== "CONFLICT" || openAiEffects !== 1) process.exit(27);

console.log("PACKED GATEWAY DIRECT PASS");
console.log("PACKED GATEWAY PROTECTED CLAIM PASS");
console.log("PACKED GATEWAY PROTECTED REPLAY PASS");
console.log("PACKED GATEWAY PAYLOAD CONFLICT PASS");
console.log("PACKED GATEWAY UNKNOWN BLOCK PASS");
console.log("PACKED OPENAI GATEWAY RETRY IDENTITY PASS");
console.log("PACKED OPENAI GATEWAY PAYLOAD CONFLICT PASS");
`,
    ],
    { cwd: sandbox },
  );

  requireSuccess(
    runtime,
    "Installed tarball failed protected Gateway execution closure",
  );

  for (const marker of [
    "PACKED GATEWAY DIRECT PASS",
    "PACKED GATEWAY PROTECTED CLAIM PASS",
    "PACKED GATEWAY PROTECTED REPLAY PASS",
    "PACKED GATEWAY PAYLOAD CONFLICT PASS",
    "PACKED GATEWAY UNKNOWN BLOCK PASS",
    "PACKED OPENAI GATEWAY RETRY IDENTITY PASS",
    "PACKED OPENAI GATEWAY PAYLOAD CONFLICT PASS",
  ]) {
    if (!runtime.stdout.includes(marker)) {
      throw new Error(`Packed Gateway confirmation missing: ${marker}`);
    }
  }

  for (const stateFile of [
    "once-packed-gateway.sqlite",
    "once-packed-openai-gateway.sqlite",
  ]) {
    if (!existsSync(path.join(sandbox, stateFile))) {
      throw new Error(`Packed Gateway did not create durable state: ${stateFile}`);
    }
  }

  console.log("PASS - installed Gateway kept direct tools direct");
  console.log("PASS - installed Gateway protected retry executed one effect");
  console.log("PASS - installed Gateway payload drift blocked another effect");
  console.log("PASS - installed Gateway blocked unresolved routing before execution");
  console.log("PASS - installed OpenAI Gateway ignored changed transport call ID for intent identity");
  console.log("PASS - installed OpenAI Gateway replayed first confirmed result");
  console.log("PASS - installed package created durable Gateway SQLite state");
  console.log("");
  console.log("ONCE GATEWAY PACKED LOCAL PROTECTION REGRESSION PASSED");
} finally {
  await rm(sandbox, { recursive: true, force: true });
  await rm(packDirectory, { recursive: true, force: true });
}

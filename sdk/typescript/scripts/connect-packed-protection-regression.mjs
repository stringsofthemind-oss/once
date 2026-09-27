import {
  mkdir,
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
const [major, minor] = process.versions.node
  .split(".")
  .map(Number);

const localReady =
  major > 24 ||
  (major === 24 && minor >= 15);

if (!localReady) {
  throw new Error(
    `Packed local protection regression requires Node.js 24.15+; running ${process.version}.`,
  );
}

const unique = `${process.pid}-${Date.now()}`;
const packDirectory = path.join(
  os.tmpdir(),
  `once-connect-protection-pack-${unique}`,
);
const sandbox = path.join(
  os.tmpdir(),
  `once-connect-protection-consumer-${unique}`,
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

console.log("");
console.log("ONCE CONNECT PACKED LOCAL PROTECTION REGRESSION");
console.log("===============================================");
console.log(`Node: ${process.version}`);

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
  // Pack the same artifact npm would receive.
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
    "npm pack failed for packed local protection regression",
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
    throw new Error("Packed SDK tarball missing");
  }

  console.log("PASS - fresh publishable tarball created");

  // --------------------------------------------------
  // Install into a completely separate consumer.
  // --------------------------------------------------
  await writeFile(
    path.join(sandbox, "package.json"),
    JSON.stringify(
      {
        name: "once-connect-protected-consumer",
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
    ["install", tarball],
    {
      cwd: sandbox,
    },
  );

  requireSuccess(
    installed,
    "Packed local-protection consumer install failed",
  );

  console.log("PASS - tarball installed outside repository");

  // --------------------------------------------------
  // Execute the installed Connect package only.
  // --------------------------------------------------
  const runtime = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import {
  connectLocalAgentToolsetAuto,
  createMcpExecutionBoundary,
} from "@once-agent/sdk/connect";

let effects = 0;

const connected = connectLocalAgentToolsetAuto(
  {
    send_email: {
      async execute(input) {
        effects += 1;
        return {
          receipt: "mail-" + effects,
          destination: input.destination,
        };
      },
    },
  },
  {
    manifest: [
      {
        name: "send_email",
        description: "Send an email to a recipient.",
        _meta: {
          once: {
            effectFields: ["destination", "body"],
          },
        },
      },
    ],
    statePath: "./once-packed-protection.sqlite",
  },
);

if (!connected.plan.ready) process.exit(10);
if (connected.plan.summary.protect !== 1) process.exit(11);

const firstInput = {
  idempotencyKey: "invoice-42",
  destination: "test@example.invalid",
  body: "Invoice 42",
};

const first = await connected.tools.send_email.execute(firstInput);
const replay = await connected.tools.send_email.execute({
  ...firstInput,
});

if (effects !== 1) process.exit(12);
if (first.receipt !== "mail-1") process.exit(13);
if (replay.receipt !== "mail-1") process.exit(14);

let conflictCode = null;

try {
  await connected.tools.send_email.execute({
    ...firstInput,
    body: "DIFFERENT EFFECT",
  });
} catch (error) {
  conflictCode = error?.code ?? null;
}

if (conflictCode !== "CONFLICT") process.exit(15);
if (effects !== 1) process.exit(16);

console.log("PACKED PROTECTED CLAIM PASS");
console.log("PACKED PROTECTED REPLAY PASS");
console.log("PACKED PAYLOAD CONFLICT PASS");

let upstreamEffects = 0;
const boundary = createMcpExecutionBoundary({
  serverId: "packed-mcp-regression",
  statePath: "./once-packed-mcp.sqlite",
  tools: [{
    name: "create_order",
    description: "Create an external order.",
    inputSchema: {
      type: "object",
      properties: {
        operation_id: { type: "string" },
        sku: { type: "string" },
      },
      required: ["operation_id", "sku"],
    },
  }],
  overrides: {
    create_order: {
      decision: "PROTECT",
      identityFields: ["operation_id"],
      effectFields: ["sku"],
    },
  },
  upstream: {
    async callTool() {
      upstreamEffects += 1;
      return { content: [{ type: "text", text: "order-" + upstreamEffects }] };
    },
  },
});

const order = {
  name: "create_order",
  arguments: { operation_id: "order-7", sku: "sku-1" },
};
const created = await boundary.callTool(order);
const repeated = await boundary.callTool(order);
if (upstreamEffects !== 1) process.exit(20);
if (JSON.stringify(created) !== JSON.stringify(repeated)) process.exit(21);
try {
  await boundary.callTool({
    name: "create_order",
    arguments: { operation_id: "order-7", sku: "sku-2" },
  });
  process.exit(22);
} catch (error) {
  if (error?.code !== "CONFLICT") process.exit(23);
}
if (upstreamEffects !== 1) process.exit(24);
console.log("PACKED MCP BOUNDARY PASS");
`,
    ],
    {
      cwd: sandbox,
    },
  );

  requireSuccess(
    runtime,
    "Installed tarball failed protected local Connect execution",
  );

  for (const marker of [
    "PACKED PROTECTED CLAIM PASS",
    "PACKED PROTECTED REPLAY PASS",
    "PACKED PAYLOAD CONFLICT PASS",
    "PACKED MCP BOUNDARY PASS",
  ]) {
    if (!runtime.stdout.includes(marker)) {
      throw new Error(
        `Packed protection confirmation missing: ${marker}`,
      );
    }
  }

  if (!existsSync(
    path.join(sandbox, "once-packed-protection.sqlite"),
  )) {
    throw new Error(
      "Packed Connect protection did not create durable SQLite state",
    );
  }

  console.log("PASS - first protected call executed one effect");
  console.log("PASS - retry replayed without a second effect");
  console.log("PASS - payload drift blocked before another effect");
  console.log("PASS - installed package created durable SQLite state");
  console.log("PASS - installed MCP boundary suppresses replay and rejects drift");

  console.log("");
  console.log("ONCE CONNECT PACKED LOCAL PROTECTION REGRESSION PASSED");
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

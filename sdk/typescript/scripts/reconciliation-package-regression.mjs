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
  `once-reconciliation-package-pack-${unique}`,
);
const sandbox = path.join(
  os.tmpdir(),
  `once-reconciliation-package-consumer-${unique}`,
);

const npm =
  process.platform === "win32"
    ? "npm.cmd"
    : "npm";

function run(command, args, options = {}) {
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
console.log("ONCE RECONCILIATION PACKAGED CONTRACT REGRESSION");
console.log("================================================");

await rm(packDirectory, { recursive: true, force: true });
await rm(sandbox, { recursive: true, force: true });
await mkdir(packDirectory, { recursive: true });
await mkdir(sandbox, { recursive: true });

try {
  const packed = run(
    npm,
    [
      "pack",
      "--json",
      "--pack-destination",
      packDirectory,
    ],
    { cwd: root },
  );

  requireSuccess(
    packed,
    "npm pack failed for reconciliation packaged contract",
  );

  const packInfo = JSON.parse(packed.stdout);
  const tarball = path.join(
    packDirectory,
    packInfo[0].filename,
  );

  if (!existsSync(tarball)) {
    throw new Error("Packed reconciliation SDK tarball missing");
  }

  await writeJson(
    path.join(sandbox, "package.json"),
    {
      name: "once-reconciliation-package-regression",
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

  await writeFile(
    path.join(sandbox, "consumer.ts"),
    `
import {
  createHttpStatusReconciliationAdapter,
  createProviderReconciliationAdapter,
  type ProviderReconciliationContext,
  type ReconciliationEvidence,
} from "@once-agent/sdk/reconciliation";

const context: ProviderReconciliationContext = {
  id: "operation-1",
  payload: { amount: 1 },
};

const generic = createProviderReconciliationAdapter({
  source: "typecheck-provider",
  lookup: async () => ({
    kind: "UNKNOWN" as const,
    detail: "no lookup in typecheck",
  }),
});

const evidence: Promise<ReconciliationEvidence<unknown>> =
  generic.inspect(context);
void evidence;

const http = createHttpStatusReconciliationAdapter({
  url: ({ id }) => \`https://example.invalid/status/\${id}\`,
  decodeFound: ({ body }) => ({
    operationId: "operation-1",
    payload: { amount: 1 },
    result: body,
  }),
});
void http;
`.trimStart(),
    "utf8",
  );

  const installed = run(
    npm,
    ["install", tarball],
    { cwd: sandbox },
  );

  requireSuccess(
    installed,
    "Reconciliation consumer npm install failed",
  );

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

  const reconciliationExport =
    installedPackage.exports?.["./reconciliation"];

  if (
    !reconciliationExport ||
    reconciliationExport.types !== "./dist/reconciliation/index.d.ts" ||
    reconciliationExport.import !== "./dist/reconciliation/index.js" ||
    reconciliationExport.require !== "./dist-cjs/reconciliation/index.js"
  ) {
    throw new Error(
      "Installed package does not expose the expected ./reconciliation contract",
    );
  }

  for (const relative of [
    "dist/reconciliation/index.d.ts",
    "dist/reconciliation/index.js",
    "dist-cjs/reconciliation/index.js",
  ]) {
    if (!existsSync(path.join(packageRoot, relative))) {
      throw new Error(
        `Installed package missing ${relative}`,
      );
    }
  }

  const typecheck = run(
    npm,
    ["run", "typecheck"],
    { cwd: sandbox },
  );

  requireSuccess(
    typecheck,
    "Installed @once-agent/sdk/reconciliation TypeScript contract failed",
  );

  const esm = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import {
  createProviderReconciliationAdapter,
} from "@once-agent/sdk/reconciliation";

const adapter = createProviderReconciliationAdapter({
  source: "esm-provider",
  lookup: async () => ({
    kind: "ABSENT_PROVEN",
    detail: "test",
  }),
});

const result = await adapter.inspect({
  id: "operation-1",
  payload: { amount: 1 },
});

if (result.state !== "ABSENT_PROVEN") process.exit(2);
console.log("RECONCILIATION ESM IMPORT PASS");
`,
    ],
    { cwd: sandbox },
  );

  requireSuccess(
    esm,
    "Installed @once-agent/sdk/reconciliation ESM import failed",
  );

  const cjs = run(
    process.execPath,
    [
      "-e",
      `
const reconciliation = require("@once-agent/sdk/reconciliation");
if (typeof reconciliation.createProviderReconciliationAdapter !== "function") process.exit(2);
if (typeof reconciliation.createHttpStatusReconciliationAdapter !== "function") process.exit(3);
console.log("RECONCILIATION CJS IMPORT PASS");
`,
    ],
    { cwd: sandbox },
  );

  requireSuccess(
    cjs,
    "Installed @once-agent/sdk/reconciliation CommonJS import failed",
  );

  console.log("reconciliation packaged contract regression: PASS");
} finally {
  await rm(sandbox, { recursive: true, force: true });
  await rm(packDirectory, { recursive: true, force: true });
}

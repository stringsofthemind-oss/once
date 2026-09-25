import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const unique = `${process.pid}-${Date.now()}`;
const packDirectory = path.join(os.tmpdir(), `once-gateway-pack-${unique}`);
const sandbox = path.join(os.tmpdir(), `once-gateway-consumer-${unique}`);
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
console.log("ONCE GATEWAY PACKAGED CONTRACT REGRESSION");
console.log("========================================");

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
  requireSuccess(packed, "npm pack failed for gateway package regression");
  const packInfo = JSON.parse(packed.stdout);
  const filename = packInfo?.[0]?.filename;
  if (typeof filename !== "string") throw new Error("Unexpected npm pack output");
  const tarball = path.join(packDirectory, filename);
  if (!existsSync(tarball)) throw new Error("Gateway tarball missing");
  console.log("PASS - fresh publishable tarball created");

  await writeJson(path.join(sandbox, "package.json"), {
    name: "once-gateway-package-regression",
    version: "1.0.0",
    private: true,
    type: "module",
  });

  const installed = run(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: sandbox },
  );
  requireSuccess(installed, "clean gateway tarball install failed");
  console.log("PASS - tarball installed into clean consumer");

  const installedRoot = path.join(
    sandbox,
    "node_modules",
    "@once-agent",
    "sdk",
  );
  for (const relative of [
    "dist/gateway/index.d.ts",
    "dist/gateway/index.js",
    "dist-cjs/gateway/index.js",
  ]) {
    if (!existsSync(path.join(installedRoot, relative))) {
      throw new Error(`Packed gateway entry missing: ${relative}`);
    }
  }
  console.log("PASS - ESM/CJS/types gateway entries are packaged");

  await writeFile(
    path.join(sandbox, "consumer.mjs"),
    `
import {
  GATEWAY_ROUTE,
  gatewayDescriptorFingerprint,
  planGatewayToolset,
} from "@once-agent/sdk/gateway";

const plan = planGatewayToolset([
  { name: "search_orders", description: "Search orders" },
  { name: "send_email", description: "Sends email" },
]);
if (!plan.ready) throw new Error("packed gateway plan should be ready");
if (plan.entries[0]?.route !== GATEWAY_ROUTE.DIRECT) throw new Error("bad packed direct route");
if (plan.entries[1]?.route !== GATEWAY_ROUTE.PROTECT) throw new Error("bad packed protect route");
if (!/^[a-f0-9]{64}$/.test(gatewayDescriptorFingerprint({ name: "x" }))) throw new Error("bad packed fingerprint");
console.log("gateway esm consumer: PASS");
`,
    "utf8",
  );
  const esm = run(process.execPath, ["consumer.mjs"], { cwd: sandbox });
  requireSuccess(esm, "ESM gateway consumer failed");
  if (!esm.stdout.includes("gateway esm consumer: PASS")) {
    throw new Error("ESM gateway consumer did not report PASS");
  }
  console.log("PASS - ESM gateway subpath executes");

  await writeFile(
    path.join(sandbox, "consumer.cjs"),
    `
const {
  GATEWAY_ROUTE,
  planGatewayToolset,
} = require("@once-agent/sdk/gateway");
const plan = planGatewayToolset([
  { name: "search_web", description: "Search the web" },
]);
if (!plan.ready || plan.entries[0]?.route !== GATEWAY_ROUTE.DIRECT) {
  throw new Error("bad CJS gateway plan");
}
console.log("gateway cjs consumer: PASS");
`,
    "utf8",
  );
  const cjs = run(process.execPath, ["consumer.cjs"], { cwd: sandbox });
  requireSuccess(cjs, "CommonJS gateway consumer failed");
  if (!cjs.stdout.includes("gateway cjs consumer: PASS")) {
    throw new Error("CommonJS gateway consumer did not report PASS");
  }
  console.log("PASS - CommonJS gateway subpath executes");

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
  planGatewayToolset,
  type GatewayPlan,
  type GatewayPlanEntry,
  type GatewayRoute,
} from "@once-agent/sdk/gateway";
const plan: Readonly<GatewayPlan> = planGatewayToolset([
  { name: "search_web", description: "Search the web" },
]);
const entry: Readonly<GatewayPlanEntry> | undefined = plan.entries[0];
const route: GatewayRoute | undefined = entry?.route;
void route;
`,
    "utf8",
  );

  const typecheck = run(npm, ["exec", "--", "tsc", "--noEmit"], {
    cwd: sandbox,
  });
  requireSuccess(typecheck, "TypeScript gateway consumer failed");
  console.log("PASS - TypeScript gateway declarations resolve");

  console.log("gateway package regression: PASS");
} finally {
  await rm(packDirectory, { recursive: true, force: true });
  await rm(sandbox, { recursive: true, force: true });
}

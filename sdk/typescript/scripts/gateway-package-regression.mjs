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
  bindGatewayPlanToToolGraph,
  connectLocalGatewayToolsetAuto,
  gatewayDescriptorFingerprint,
  planGatewayToolset,
} from "@once-agent/sdk/gateway";

const manifest = [
  { name: "search_orders", description: "Search orders" },
  { name: "send_email", description: "Sends email" },
];
const plan = planGatewayToolset(manifest);
if (!plan.ready) throw new Error("packed gateway plan should be ready");
if (plan.entries[0]?.route !== GATEWAY_ROUTE.DIRECT) throw new Error("bad packed direct route");
if (plan.entries[1]?.route !== GATEWAY_ROUTE.PROTECT) throw new Error("bad packed protect route");
if (!/^[a-f0-9]{64}$/.test(gatewayDescriptorFingerprint({ name: "x" }))) throw new Error("bad packed fingerprint");

const bindings = plan.entries.map((entry, index) => ({
  toolId: "tool:" + index,
  namespacedName: "packed/" + entry.name,
  canonicalName: entry.name,
  descriptorFingerprint: entry.descriptorFingerprint,
  evidenceLevel: index === 1 ? "EXECUTED" : "MODEL_VISIBLE",
  actionPriorityScore: index === 1 ? 99 : 5,
  protection: index === 1 ? "ONCE_HEALTHY" : "NONE",
}));
const bound = bindGatewayPlanToToolGraph(plan, [
  ...bindings,
  {
    toolId: "tool:global-only",
    namespacedName: "global/delete_everything",
    canonicalName: "delete_everything",
    descriptorFingerprint: "f".repeat(64),
    evidenceLevel: "EXECUTED",
    actionPriorityScore: 100,
    protection: "NONE",
  },
]);
if (!bound.ready || bound.entries.length !== 2) throw new Error("bad packed Tool Graph binding");
if (bound.entries[1]?.route !== GATEWAY_ROUTE.PROTECT) throw new Error("Tool Graph metadata weakened protect route");

const stale = bindGatewayPlanToToolGraph(plan, [
  bindings[0],
  { ...bindings[1], descriptorFingerprint: "0".repeat(64) },
]);
if (stale.ready || stale.entries[1]?.bindingStatus !== "FINGERPRINT_MISMATCH") {
  throw new Error("stale packed binding did not fail closed");
}

let directCalls = 0;
const directOnlyManifest = [manifest[0]];
const directOnlyPlan = planGatewayToolset(directOnlyManifest);
const gateway = connectLocalGatewayToolsetAuto(
  {
    search_orders: {
      async execute(input) {
        directCalls++;
        return input;
      },
    },
  },
  {
    manifest: directOnlyManifest,
    toolGraphBindings: [{
      toolId: "tool:direct",
      namespacedName: "packed/search_orders",
      canonicalName: "search_orders",
      descriptorFingerprint: directOnlyPlan.entries[0].descriptorFingerprint,
      evidenceLevel: "MODEL_VISIBLE",
      protection: "NONE",
    }],
  },
);
await gateway.tools.search_orders.execute({ q: "x" });
if (directCalls !== 1 || !gateway.binding?.ready) throw new Error("packed direct gateway broker failed");

console.log("gateway esm consumer: PASS");
`,
    "utf8",
  );
  const esm = run(process.execPath, ["consumer.mjs"], { cwd: sandbox });
  requireSuccess(esm, "ESM gateway consumer failed");
  if (!esm.stdout.includes("gateway esm consumer: PASS")) {
    throw new Error("ESM gateway consumer did not report PASS");
  }
  console.log("PASS - ESM gateway planning, binding, and direct broker execute");

  await writeFile(
    path.join(sandbox, "consumer.cjs"),
    `
const gateway = require("@once-agent/sdk/gateway");
for (const name of [
  "planGatewayToolset",
  "bindGatewayPlanToToolGraph",
  "connectLocalGatewayToolsetAuto",
]) {
  if (typeof gateway[name] !== "function") throw new Error("missing CJS gateway API: " + name);
}
const plan = gateway.planGatewayToolset([
  { name: "search_web", description: "Search the web" },
]);
if (!plan.ready || plan.entries[0]?.route !== gateway.GATEWAY_ROUTE.DIRECT) {
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
  console.log("PASS - CommonJS gateway APIs resolve");

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
  bindGatewayPlanToToolGraph,
  connectLocalGatewayToolsetAuto,
  planGatewayToolset,
  type BoundGatewayPlan,
  type GatewayPlan,
  type GatewayPlanEntry,
  type GatewayRoute,
  type GatewayToolGraphBinding,
  type LocalGatewayToolsetOptions,
} from "@once-agent/sdk/gateway";
const plan: Readonly<GatewayPlan> = planGatewayToolset([
  { name: "search_web", description: "Search the web" },
]);
const entry: Readonly<GatewayPlanEntry> | undefined = plan.entries[0];
const route: GatewayRoute | undefined = entry?.route;
const bindings: readonly GatewayToolGraphBinding[] = entry ? [{
  toolId: "tool:typed",
  namespacedName: "typed/search_web",
  canonicalName: "search_web",
  descriptorFingerprint: entry.descriptorFingerprint,
  evidenceLevel: "MODEL_VISIBLE",
}] : [];
const bound: BoundGatewayPlan = bindGatewayPlanToToolGraph(plan, bindings);
const options: LocalGatewayToolsetOptions = { manifest: [{ name: "search_web", description: "Search the web" }], toolGraphBindings: bindings };
void connectLocalGatewayToolsetAuto;
void bound;
void options;
void route;
`,
    "utf8",
  );

  const typecheck = run(npm, ["exec", "--", "tsc", "--noEmit"], {
    cwd: sandbox,
  });
  requireSuccess(typecheck, "TypeScript gateway consumer failed");
  console.log("PASS - TypeScript gateway binding declarations resolve");

  console.log("gateway package regression: PASS");
} finally {
  await rm(packDirectory, { recursive: true, force: true });
  await rm(sandbox, { recursive: true, force: true });
}

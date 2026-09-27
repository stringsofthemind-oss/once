import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkTarball = process.argv[2] && path.resolve(process.argv[2]);
if (!sdkTarball) throw new Error("Pass the packed SDK tarball path");
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/stdio-upstream.mjs", import.meta.url));
const toolsPath = fileURLToPath(new URL("./fixtures/stdio-tools.json", import.meta.url));
const temp = mkdtempSync(path.join(os.tmpdir(), "once-mcp-packed-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(args, cwd) {
  const result = spawnSync(npm, args, { cwd, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error(`npm ${args[0]} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

try {
  const info = JSON.parse(run(["pack", "--json", "--pack-destination", temp], root))[0];
  assert.ok(info.files.some(file => file.path === "scripts/stdio-proxy.mjs"));
  const mcpTarball = path.join(temp, info.filename);
  writeFileSync(path.join(temp, "package.json"),
    JSON.stringify({ name: "once-packed-proxy-consumer", private: true, type: "module" }));
  run(["install", "--ignore-scripts", "--no-save", sdkTarball, mcpTarball,
    "@modelcontextprotocol/client@2.0.0"], temp);

  const consumer = `
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { catalogDigest } from "@once-agent/mcp/scripts/stdio-proxy.mjs";
import { fileURLToPath } from "node:url";

const [fixture, toolsPath, effectsPath, configPath] = process.argv.slice(2);
const tools = JSON.parse(readFileSync(toolsPath, "utf8"));
writeFileSync(configPath, JSON.stringify({
  serverId: "packed-disposable",
  command: process.execPath,
  args: [fixture, effectsPath],
  statePath: configPath + ".sqlite",
  expectedCatalogSha256: catalogDigest(tools),
  tools: {
    create_order: {
      decision: "PROTECT",
      identityFields: ["operation_id"],
      effectFields: ["sku", "quantity"],
    },
    read_count: { decision: "BYPASS" },
  },
}));
const client = new Client({ name: "packed-once-consumer", version: "0.0.1" });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./node_modules/@once-agent/mcp/dist/index.js", import.meta.url)),
      "proxy", "--config", configPath],
  }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name),
    ["create_order", "read_count"]);
  const request = { name: "create_order",
    arguments: { operation_id: "packed-1", sku: "sku-1", quantity: 1 } };
  const first = await client.callTool(request);
  assert.deepEqual(await client.callTool(request), first);
  assert.equal(readFileSync(effectsPath, "utf8").trim().split("\\n").length, 1);
  await assert.rejects(client.callTool({ name: "create_order",
    arguments: { operation_id: "packed-1", sku: "sku-2", quantity: 1 } }));
  assert.equal(readFileSync(effectsPath, "utf8").trim().split("\\n").length, 1);
  console.log("PACKED MCP PROXY: PASS");
} finally {
  await client.close();
}
`;
  const consumerPath = path.join(temp, "consumer.mjs");
  writeFileSync(consumerPath, consumer);
  const result = spawnSync(process.execPath,
    [consumerPath, fixture, toolsPath, path.join(temp, "effects.jsonl"),
      path.join(temp, "config.json")],
    { cwd: temp, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0 || !result.stdout.includes("PACKED MCP PROXY: PASS")) {
    throw new Error(`Packed consumer failed: ${result.stderr || result.stdout}`);
  }
  console.log(result.stdout.trim());
} finally {
  rmSync(temp, { recursive: true, force: true });
}

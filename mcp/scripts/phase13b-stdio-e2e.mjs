import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { catalogDigest, connectStdioProxy } from "./stdio-proxy.mjs";

const fixture = fileURLToPath(new URL("./fixtures/stdio-upstream.mjs", import.meta.url));
const tools = JSON.parse(readFileSync(new URL("./fixtures/stdio-tools.json", import.meta.url), "utf8"));
const dir = mkdtempSync(path.join(os.tmpdir(), "once-stdio-e2e-"));
const effectsPath = path.join(dir, "effects.jsonl");
const driftPath = path.join(dir, "catalog-drift.txt");
const config = {
  serverId: "disposable-orders",
  command: process.execPath,
  args: [fixture, effectsPath, driftPath],
  statePath: path.join(dir, "state.sqlite"),
  expectedCatalogSha256: catalogDigest(tools),
  tools: {
    create_order: {
      decision: "PROTECT",
      identityFields: ["operation_id"],
      effectFields: ["sku", "quantity"],
    },
    read_count: { decision: "BYPASS" },
  },
};
const count = () => {
  try { return readFileSync(effectsPath, "utf8").trim().split("\n").filter(Boolean).length; }
  catch { return 0; }
};

async function attach(proxy) {
  const client = new Client({ name: "once-disposable-downstream", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

let proxy;
let client;
try {
  await assert.rejects(connectStdioProxy({
    ...config, expectedCatalogSha256: "0".repeat(64),
  }), /TOOL_SCHEMA_CHANGED/);
  assert.equal(count(), 0);

  proxy = await connectStdioProxy(config);
  assert.equal(proxy.plan.protect.length, 1);
  assert.equal(proxy.plan.bypass.length, 1);
  client = await attach(proxy);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name),
    ["create_order", "read_count"]);
  const call = { name: "create_order",
    arguments: { operation_id: "order-1", sku: "sku-1", quantity: 1 } };
  const first = await client.callTool(call);
  const second = await client.callTool(call);
  assert.deepEqual(second, first);
  assert.equal(count(), 1);
  const read = await client.callTool({ name: "read_count", arguments: {} });
  assert.equal(read.content[0].text, "1");
  // Small CI microbenchmark: the same disposable process through direct MCP
  // and through Once. These are observations, not a production latency claim.
  const direct = new Client({ name: "once-latency-control", version: "0.0.1" });
  await direct.connect(new StdioClientTransport({
    command: config.command, args: config.args,
  }));
  const sample = async fn => {
    const values = [];
    for (let i = 0; i < 25; i++) {
      const started = performance.now();
      await fn();
      values.push(performance.now() - started);
    }
    values.sort((a, b) => a - b);
    return { p50: Number(values[12].toFixed(2)), p95: Number(values[23].toFixed(2)) };
  };
  try {
    const directRead = await sample(() =>
      direct.callTool({ name: "read_count", arguments: {} }));
    const bypass = await sample(() =>
      client.callTool({ name: "read_count", arguments: {} }));
    const replay = await sample(() => client.callTool(call));
    console.log("ONCE PHASE13B LATENCY MS", JSON.stringify({ directRead, bypass, replay }));
  } finally {
    await direct.close();
  }
  await assert.rejects(client.callTool({ name: "create_order",
    arguments: { operation_id: "order-1", sku: "sku-1", quantity: 2 } }));
  assert.equal(count(), 1);
  await assert.rejects(client.callTool({ name: "create_order",
    arguments: { sku: "sku-1", quantity: 1 } }));
  assert.equal(count(), 1);

  await client.close();
  await proxy.close();
  client = undefined;
  proxy = await connectStdioProxy(config);
  client = await attach(proxy);
  assert.deepEqual(await client.callTool(call), first);
  assert.equal(count(), 1);

  const simultaneous = { name: "create_order",
    arguments: { operation_id: "order-concurrent", sku: "sku-2", quantity: 1 } };
  const concurrentResults = await Promise.allSettled(
    Array.from({ length: 4 }, () => client.callTool(simultaneous)));
  const completed = concurrentResults.filter(result => result.status === "fulfilled");
  assert.ok(completed.length >= 1);
  for (const result of concurrentResults) {
    if (result.status === "rejected") {
      assert.match(String(result.reason), /still in flight/);
    }
  }
  const settledRetry = await client.callTool(simultaneous);
  assert.deepEqual(settledRetry, completed[0].value);
  assert.equal(count(), 2);

  const uncertain = { name: "create_order",
    arguments: { operation_id: "order-2", sku: "lost-ack", quantity: 1 } };
  await assert.rejects(client.callTool(uncertain));
  assert.equal(count(), 2);
  await assert.rejects(client.callTool(uncertain));
  assert.equal(count(), 2);
  // Launch the real proxy executable as a distinct process, with its own upstream.
  await client.close();
  await proxy.close();
  client = undefined;
  proxy = undefined;
  const configPath = path.join(dir, "mcp.json");
  writeFileSync(configPath, JSON.stringify(config));
  const cli = new Client({ name: "once-cli-downstream", version: "0.0.1" });
  try {
    await cli.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("./stdio-proxy.mjs", import.meta.url)),
        "--config", configPath],
    }));
    assert.deepEqual((await cli.listTools()).tools.map(tool => tool.name),
      ["create_order", "read_count"]);
    assert.deepEqual(await cli.callTool(call), first);
    assert.equal(count(), 3);
  } finally {
    await cli.close();
  }
  // A server that silently changes its catalog must be blocked before dispatch.
  for (const mutation of ["description", "schema", "annotation", "removed",
    "added", "required", "field"]) {
    proxy = await connectStdioProxy(config);
    client = await attach(proxy);
    writeFileSync(driftPath, mutation);
    await assert.rejects(client.callTool({ name: "create_order",
      arguments: { operation_id: "drift-" + mutation, sku: "sku-3", quantity: 1 } }),
      /TOOL_SCHEMA_CHANGED/);
    assert.equal(count(), 3);
    await client.close();
    await proxy.close();
    client = undefined;
    proxy = undefined;
    unlinkSync(driftPath);
  }
  console.log("ONCE PHASE 13B STDIO PROCESS: PASS");
} finally {
  await client?.close();
  await proxy?.close();
  rmSync(dir, { recursive: true, force: true });
}

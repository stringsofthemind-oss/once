import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { catalogDigest, connectStdioProxy } from "./stdio-proxy.mjs";

const fixture = fileURLToPath(new URL("./fixtures/stdio-upstream.mjs", import.meta.url));
const hangConnectFixture = fileURLToPath(new URL("./fixtures/stdio-hang-connect.mjs", import.meta.url));
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
const countFile = file => {
  try { return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length; }
  catch { return 0; }
};
const count = () => countFile(effectsPath);

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

  await assert.rejects(connectStdioProxy({
    ...config, timeouts: { callMs: 0 },
  }), /INVALID_PROXY_CONFIG: timeouts.callMs/);

  // A process that never completes initialize must not hold the agent forever.
  const connectStarted = performance.now();
  await assert.rejects(connectStdioProxy({
    ...config,
    args: [hangConnectFixture],
    timeouts: { connectMs: 100, catalogMs: 500, callMs: 500 },
  }), /UPSTREAM_CONNECT_TIMEOUT/);
  assert.ok(performance.now() - connectStarted < 2_000);
  assert.equal(count(), 0);

  // Catalog discovery is also bounded and happens before any tool dispatch.
  writeFileSync(driftPath, "hang-list");
  const catalogStarted = performance.now();
  await assert.rejects(connectStdioProxy({
    ...config,
    timeouts: { connectMs: 1_000, catalogMs: 100, callMs: 500 },
  }), /UPSTREAM_CATALOG_TIMEOUT/);
  assert.ok(performance.now() - catalogStarted < 2_000);
  assert.equal(count(), 0);
  unlinkSync(driftPath);

  // MCP client v2.0.0 auto-aggregation can silently truncate a catalog when a
  // server legally repeats an opaque cursor. Once walks raw pages separately,
  // primes the SDK cache, and refuses to proceed if the two inventories differ.
  writeFileSync(driftPath, "repeated-cursor");
  await assert.rejects(connectStdioProxy(config),
    /INVALID_TOOL_CATALOG: SDK aggregate differs from raw catalog/);
  assert.equal(count(), 0);
  unlinkSync(driftPath);

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
      await fn(i);
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
  assert.equal(count(), 3);
  await assert.rejects(client.callTool(uncertain));
  assert.equal(count(), 3);
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
      args: [fileURLToPath(new URL("../dist/index.js", import.meta.url)),
        "proxy", "--config", configPath],
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
    const mutableConfig = structuredClone(config);
    proxy = await connectStdioProxy(mutableConfig);
    client = await attach(proxy);
    if (mutation === "schema") {
      mutableConfig.expectedCatalogSha256 = "0".repeat(64);
      mutableConfig.tools.create_order.decision = "BYPASS";
      mutableConfig.tools.create_order.identityFields.push("sku");
    }
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
  // The upstream exits after committing an effect. A fresh Once process
  // must retain UNKNOWN and refuse to execute it a second time.
  proxy = await connectStdioProxy(config);
  client = await attach(proxy);
  const crashing = { name: "create_order",
    arguments: { operation_id: "order-crash", sku: "crash", quantity: 1 } };
  await assert.rejects(client.callTool(crashing));
  assert.equal(count(), 4);
  await client.close();
  await proxy.close();
  client = undefined;
  proxy = await connectStdioProxy(config);
  client = await attach(proxy);
  await assert.rejects(client.callTool(crashing));
  assert.equal(count(), 4);
  await client.close();
  await proxy.close();
  client = undefined;
  proxy = undefined;
  // Two independent Once processes race on the same logical action and SQLite file.
  const peerClients = Array.from({ length: 2 }, (_, i) =>
    new Client({ name: "once-peer-" + i, version: "0.0.1" }));
  try {
    await Promise.all(peerClients.map(peer => peer.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/index.js", import.meta.url)),
        "proxy", "--config", configPath],
    }))));
    const shared = { name: "create_order",
      arguments: { operation_id: "order-two-processes", sku: "sku-4", quantity: 1 } };
    const outcomes = await Promise.allSettled(peerClients.map(peer => peer.callTool(shared)));
    const successful = outcomes.filter(outcome => outcome.status === "fulfilled");
    assert.ok(successful.length >= 1);
    assert.equal(count(), 5);
    assert.deepEqual(await peerClients[0].callTool(shared), successful[0].value);
    assert.deepEqual(await peerClients[1].callTool(shared), successful[0].value);
    assert.equal(count(), 5);
  } finally {
    await Promise.all(peerClients.map(peer => peer.close()));
  }
  // Separate state/effects prevent benchmark writes from masking safety counts.
  const benchEffects = path.join(dir, "benchmark-effects.jsonl");
  const benchConfig = { ...config,
    args: [fixture, benchEffects, driftPath],
    statePath: path.join(dir, "benchmark-state.sqlite") };
  const benchProxy = await connectStdioProxy(benchConfig);
  const benchClient = await attach(benchProxy);
  const directWrite = new Client({ name: "once-write-control", version: "0.0.1" });
  try {
    await directWrite.connect(new StdioClientTransport({
      command: benchConfig.command, args: benchConfig.args,
    }));
    const directFirst = await sample(i => directWrite.callTool({
      name: "create_order",
      arguments: { operation_id: "direct-" + i, sku: "bench", quantity: 1 },
    }));
    const protectedFirst = await sample(i => benchClient.callTool({
      name: "create_order",
      arguments: { operation_id: "once-" + i, sku: "bench", quantity: 1 },
    }));
    console.log("ONCE PHASE13B FIRST CALL LATENCY MS",
      JSON.stringify({ directFirst, protectedFirst }));
  } finally {
    await directWrite.close();
    await benchClient.close();
    await benchProxy.close();
  }

  // A write that commits and then stops responding must time out into durable
  // UNKNOWN, invalidate the current upstream channel, and never execute twice.
  const timeoutEffects = path.join(dir, "timeout-effects.jsonl");
  const timeoutConfig = {
    ...config,
    args: [fixture, timeoutEffects, driftPath],
    statePath: path.join(dir, "timeout-state.sqlite"),
    timeouts: { connectMs: 1_000, catalogMs: 1_000, callMs: 100 },
  };
  const timedCall = { name: "create_order",
    arguments: { operation_id: "order-timeout", sku: "hang-after", quantity: 1 } };
  proxy = await connectStdioProxy(timeoutConfig);
  client = await attach(proxy);
  const callStarted = performance.now();
  await assert.rejects(client.callTool(timedCall));
  assert.ok(performance.now() - callStarted < 2_000);
  assert.equal(countFile(timeoutEffects), 1);

  // Once the timeout makes transport health unknowable, unrelated work on that
  // same channel is rejected promptly rather than flowing around the failure.
  const unavailableStarted = performance.now();
  await assert.rejects(client.callTool({ name: "read_count", arguments: {} }));
  assert.ok(performance.now() - unavailableStarted < 2_000);
  assert.equal(countFile(timeoutEffects), 1);

  await client.close();
  await proxy.close();
  client = undefined;
  proxy = await connectStdioProxy(timeoutConfig);
  client = await attach(proxy);
  const retryStarted = performance.now();
  await assert.rejects(client.callTool(timedCall));
  assert.ok(performance.now() - retryStarted < 2_000);
  assert.equal(countFile(timeoutEffects), 1);
  await client.close();
  await proxy.close();
  client = undefined;
  proxy = undefined;

  console.log("ONCE PHASE 13B STDIO PROCESS: PASS");
} finally {
  await client?.close();
  await proxy?.close();
  rmSync(dir, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as SourceConnect from "../../sdk/typescript/dist/connect/index.js";
import { catalogDigest, connectStdioProxy } from "./stdio-proxy.mjs";

const fixture = fileURLToPath(new URL("./fixtures/stdio-upstream.mjs", import.meta.url));
const tools = JSON.parse(readFileSync(new URL("./fixtures/stdio-tools.json", import.meta.url), "utf8"));
const root = mkdtempSync(path.join(os.tmpdir(), "once-phase13c-persistent-"));

function count(file) {
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function configFor(name, options = {}) {
  const dir = path.join(root, name);
  const effectsPath = path.join(dir, "effects.jsonl");
  const driftPath = path.join(dir, "catalog-drift.txt");
  const statePath = path.join(dir, "state.sqlite");
  writeFileSync(effectsPath, "", { flag: "w" });
  return {
    dir,
    effectsPath,
    driftPath,
    statePath,
    config: {
      serverId: `persistent-${name}`,
      command: process.execPath,
      args: [fixture, effectsPath, driftPath],
      statePath,
      expectedCatalogSha256: catalogDigest(tools),
      tools: {
        create_order: {
          decision: "PROTECT",
          identityFields: ["operation_id"],
          effectFields: ["sku", "quantity"],
        },
        read_count: { decision: "BYPASS" },
      },
      ...options,
    },
  };
}

async function attach(proxy, label) {
  const client = new Client({ name: label, version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function closePair(client, proxy) {
  try {
    await client?.close();
  } finally {
    await proxy?.close();
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1,
    Math.floor((sorted.length - 1) * p))].toFixed(2));
}

async function sample(fn, n = 25) {
  const values = [];
  for (let i = 0; i < n; i++) {
    const started = performance.now();
    await fn(i);
    values.push(performance.now() - started);
  }
  return { p50: percentile(values, 0.50), p95: percentile(values, 0.95) };
}

try {
  // Persistent source-tree path preserves replay, concurrency and restart behavior.
  const primary = configFor("primary");
  let proxy = await connectStdioProxy(primary.config, SourceConnect);
  assert.equal(proxy.persistentLocalState, true);
  let client = await attach(proxy, "persistent-primary");
  const firstCall = {
    name: "create_order",
    arguments: { operation_id: "p-1", sku: "one", quantity: 1 },
  };
  const first = await client.callTool(firstCall);
  assert.deepEqual(await client.callTool(firstCall), first);
  assert.equal(count(primary.effectsPath), 1);

  const concurrent = {
    name: "create_order",
    arguments: { operation_id: "p-2", sku: "two", quantity: 1 },
  };
  const outcomes = await Promise.allSettled(
    Array.from({ length: 4 }, () => client.callTool(concurrent)));
  const fulfilled = outcomes.filter(result => result.status === "fulfilled");
  assert.ok(fulfilled.length >= 1);
  assert.deepEqual(await client.callTool(concurrent), fulfilled[0].value);
  assert.equal(count(primary.effectsPath), 2);

  await closePair(client, proxy);
  client = undefined;
  proxy = await connectStdioProxy(primary.config, SourceConnect);
  client = await attach(proxy, "persistent-restart");
  assert.deepEqual(await client.callTool(firstCall), first);
  assert.equal(count(primary.effectsPath), 2);
  await closePair(client, proxy);
  client = undefined;
  proxy = undefined;

  // Two independent persistent connections sharing one SQLite file still claim once.
  const peerA = await connectStdioProxy(primary.config, SourceConnect);
  const peerB = await connectStdioProxy(primary.config, SourceConnect);
  const peerClientA = await attach(peerA, "persistent-peer-a");
  const peerClientB = await attach(peerB, "persistent-peer-b");
  try {
    const shared = {
      name: "create_order",
      arguments: { operation_id: "p-3", sku: "three", quantity: 1 },
    };
    const peerOutcomes = await Promise.allSettled([
      peerClientA.callTool(shared),
      peerClientB.callTool(shared),
    ]);
    assert.ok(peerOutcomes.some(result => result.status === "fulfilled"));
    assert.equal(count(primary.effectsPath), 3);
    await peerClientA.callTool(shared);
    await peerClientB.callTool(shared);
    assert.equal(count(primary.effectsPath), 3);
  } finally {
    await closePair(peerClientA, peerA);
    await closePair(peerClientB, peerB);
  }

  // A write that commits and then hangs remains UNKNOWN across a fresh session.
  const timeout = configFor("timeout", {
    timeouts: { connectMs: 1_000, catalogMs: 1_000, callMs: 100 },
  });
  const timedCall = {
    name: "create_order",
    arguments: { operation_id: "p-timeout", sku: "hang-after", quantity: 1 },
  };
  proxy = await connectStdioProxy(timeout.config, SourceConnect);
  client = await attach(proxy, "persistent-timeout");
  await assert.rejects(client.callTool(timedCall));
  assert.equal(count(timeout.effectsPath), 1);
  await closePair(client, proxy);
  client = undefined;
  proxy = await connectStdioProxy(timeout.config, SourceConnect);
  client = await attach(proxy, "persistent-timeout-restart");
  await assert.rejects(client.callTool(timedCall));
  assert.equal(count(timeout.effectsPath), 1);
  await closePair(client, proxy);
  client = undefined;
  proxy = undefined;

  // Replacing the live durable file invalidates the session before another write.
  const lost = configFor("lost-state");
  proxy = await connectStdioProxy(lost.config, SourceConnect);
  client = await attach(proxy, "persistent-lost-state");
  await client.callTool({
    name: "create_order",
    arguments: { operation_id: "p-loss-1", sku: "safe", quantity: 1 },
  });
  assert.equal(count(lost.effectsPath), 1);
  unlinkSync(lost.statePath);
  writeFileSync(lost.statePath, "replacement-state-file");
  await assert.rejects(client.callTool({
    name: "create_order",
    arguments: { operation_id: "p-loss-2", sku: "must-not-run", quantity: 1 },
  }), /STATE_UNAVAILABLE|durable Once state/i);
  assert.equal(count(lost.effectsPath), 1);
  await closePair(client, proxy);
  client = undefined;
  proxy = undefined;

  // Source-tree end-to-end latency comparison. This is a disposable CI sample,
  // not a production performance claim.
  const bench = configFor("benchmark");
  proxy = await connectStdioProxy(bench.config, SourceConnect);
  client = await attach(proxy, "persistent-benchmark");
  const direct = new Client({ name: "persistent-direct-control", version: "0.0.1" });
  await direct.connect(new StdioClientTransport({
    command: bench.config.command,
    args: bench.config.args,
  }));
  try {
    const directFirst = await sample(i => direct.callTool({
      name: "create_order",
      arguments: { operation_id: `direct-${i}`, sku: "bench", quantity: 1 },
    }));
    const persistentFirst = await sample(i => client.callTool({
      name: "create_order",
      arguments: { operation_id: `once-${i}`, sku: "bench", quantity: 1 },
    }));
    console.log("ONCE PHASE13C PERSISTENT FIRST CALL LATENCY MS",
      JSON.stringify({ directFirst, persistentFirst }));
  } finally {
    await direct.close();
    await closePair(client, proxy);
  }

  // All proxy sessions have closed; cleanup must not be held open by SQLite.
  rmSync(primary.dir, { recursive: true, force: true });
  console.log("ONCE PHASE 13C PERSISTENT STATE: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}

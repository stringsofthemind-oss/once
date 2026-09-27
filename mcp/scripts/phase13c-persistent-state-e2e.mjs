import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import * as SourceConnect from "../../sdk/typescript/dist/connect/index.js";
import { catalogDigest, connectStdioProxy } from "./stdio-proxy.mjs";

const SourceBoundaryOnly = Object.freeze({
  createMcpExecutionBoundary: SourceConnect.createMcpExecutionBoundary,
});
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
  mkdirSync(dir, { recursive: true });
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

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => Number(sorted[Math.min(sorted.length - 1,
    Math.floor((sorted.length - 1) * p))].toFixed(2));
  return { p50: at(0.50), p95: at(0.95) };
}

async function sample(fn, n = 25) {
  const values = [];
  for (let i = 0; i < n; i++) {
    const started = performance.now();
    await fn(i);
    values.push(performance.now() - started);
  }
  return summarize(values);
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

  // Compare source-tree transient and persistent paths on the same runner and
  // alternate sample order to reduce cache/order bias. This is diagnostic CI
  // evidence, not a production latency claim.
  const persistentBench = configFor("benchmark-persistent");
  const transientBench = configFor("benchmark-transient");
  const directBench = configFor("benchmark-direct");
  const persistentProxy = await connectStdioProxy(persistentBench.config, SourceConnect);
  const transientProxy = await connectStdioProxy(transientBench.config, SourceBoundaryOnly);
  assert.equal(persistentProxy.persistentLocalState, true);
  assert.equal(transientProxy.persistentLocalState, false);
  const persistentClient = await attach(persistentProxy, "persistent-benchmark");
  const transientClient = await attach(transientProxy, "transient-benchmark");
  const direct = new Client({ name: "persistent-direct-control", version: "0.0.1" });
  await direct.connect(new StdioClientTransport({
    command: directBench.config.command,
    args: directBench.config.args,
  }));
  try {
    // Warm the long-lived state session so startup is not confused with steady-state writes.
    await persistentClient.callTool({
      name: "create_order",
      arguments: { operation_id: "persistent-warm", sku: "bench", quantity: 1 },
    });
    await transientClient.callTool({
      name: "create_order",
      arguments: { operation_id: "transient-warm", sku: "bench", quantity: 1 },
    });

    const directFirst = await sample(i => direct.callTool({
      name: "create_order",
      arguments: { operation_id: `direct-${i}`, sku: "bench", quantity: 1 },
    }), 30);

    const persistentValues = [];
    const transientValues = [];
    const timed = async (target, request, values) => {
      const started = performance.now();
      await target.callTool(request);
      values.push(performance.now() - started);
    };
    for (let i = 0; i < 30; i++) {
      const persistentRequest = {
        name: "create_order",
        arguments: { operation_id: `once-p-${i}`, sku: "bench", quantity: 1 },
      };
      const transientRequest = {
        name: "create_order",
        arguments: { operation_id: `once-t-${i}`, sku: "bench", quantity: 1 },
      };
      if (i % 2 === 0) {
        await timed(persistentClient, persistentRequest, persistentValues);
        await timed(transientClient, transientRequest, transientValues);
      } else {
        await timed(transientClient, transientRequest, transientValues);
        await timed(persistentClient, persistentRequest, persistentValues);
      }
    }
    console.log("ONCE PHASE13C FIRST CALL A/B LATENCY MS", JSON.stringify({
      directFirst,
      transientFirst: summarize(transientValues),
      persistentFirst: summarize(persistentValues),
    }));
  } finally {
    await direct.close();
    await closePair(persistentClient, persistentProxy);
    await closePair(transientClient, transientProxy);
  }

  // All proxy sessions have closed; cleanup must not be held open by SQLite.
  rmSync(primary.dir, { recursive: true, force: true });
  console.log("ONCE PHASE 13C PERSISTENT STATE: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}

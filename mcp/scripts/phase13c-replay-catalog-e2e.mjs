import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { catalogDigest, connectStdioProxy } from "./stdio-proxy.mjs";

const fixture = fileURLToPath(new URL("./fixtures/stdio-upstream.mjs", import.meta.url));
const tools = JSON.parse(readFileSync(new URL("./fixtures/stdio-tools.json", import.meta.url), "utf8"));
const dir = mkdtempSync(path.join(os.tmpdir(), "once-replay-catalog-"));
const effectsPath = path.join(dir, "effects.jsonl");
const driftPath = path.join(dir, "catalog-drift.txt");
const statePath = path.join(dir, "state.sqlite");
const config = {
  serverId: "replay-catalog-proof",
  command: process.execPath,
  args: [fixture, effectsPath, driftPath],
  statePath,
  expectedCatalogSha256: catalogDigest(tools),
  timeouts: { connectMs: 1_000, catalogMs: 100, callMs: 1_000 },
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
  const client = new Client({ name: "once-replay-catalog-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

let proxy;
let client;
try {
  proxy = await connectStdioProxy(config);
  client = await attach(proxy);

  const call = {
    name: "create_order",
    arguments: { operation_id: "replay-fast-path", sku: "sku-fast", quantity: 1 },
  };
  const first = await client.callTool(call);
  assert.equal(count(), 1);

  // If the proxy still performed tools/list before every downstream call this
  // replay would hit the 100 ms catalog timeout. A confirmed protected replay
  // must instead return its durable receipt without touching the upstream.
  writeFileSync(driftPath, "hang-list");
  const replay = await client.callTool({
    name: "create_order",
    arguments: { quantity: 1, sku: "sku-fast", operation_id: "replay-fast-path" },
  });
  assert.deepEqual(replay, first);
  assert.equal(count(), 1);
  unlinkSync(driftPath);

  // The fast path must never become an execution bypass. A new protected
  // operation still performs a fresh complete catalog verification first.
  writeFileSync(driftPath, "schema");
  await assert.rejects(client.callTool({
    name: "create_order",
    arguments: { operation_id: "new-after-drift", sku: "sku-fast", quantity: 1 },
  }), /TOOL_SCHEMA_CHANGED/);
  assert.equal(count(), 1);
  unlinkSync(driftPath);

  console.log("ONCE PHASE 13C REPLAY CATALOG FAST PATH: PASS");
} finally {
  await client?.close();
  await proxy?.close();
  rmSync(dir, { recursive: true, force: true });
}

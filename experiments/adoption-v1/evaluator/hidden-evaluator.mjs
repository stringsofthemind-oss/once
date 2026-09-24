import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function tempState(name) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `adoption-v1-${name}-`)
  );

  return path.join(dir, "provider.json");
}

async function loadCandidate(fixturePath, nonce = "") {
  const candidatePath =
    path.join(fixturePath, "src", "create-order.mjs");

  const url = pathToFileURL(candidatePath);

  if (nonce) {
    url.searchParams.set("run", nonce);
  }

  return await import(url.href);
}

async function loadProvider(fixturePath, nonce = "") {
  const providerPath =
    path.join(fixturePath, "src", "provider.mjs");

  const url = pathToFileURL(providerPath);

  if (nonce) {
    url.searchParams.set("run", nonce);
  }

  return await import(url.href);
}

function input(operationId, sku = "SKU-RED-1") {
  return {
    operationId,
    sku,
    quantity: 1
  };
}

async function ordinaryExecution(fixturePath) {
  const statePath = tempState("ordinary");

  const { AmbiguousOrderProvider } =
    await loadProvider(fixturePath, "ordinary");

  const { createOrderTool } =
    await loadCandidate(fixturePath, "ordinary");

  const provider =
    new AmbiguousOrderProvider(statePath);

  const tool = createOrderTool({ provider });

  const result = await tool(
    input("order:ordinary:1")
  );

  assert.ok(result, "ordinary execution returned no result");

  assert.equal(
    provider.getOrders().length,
    1,
    "ordinary operation should execute exactly once"
  );

  return "S3";
}

async function ambiguousRetry(fixturePath) {
  const statePath = tempState("ambiguous");

  const { AmbiguousOrderProvider } =
    await loadProvider(fixturePath, "ambiguous");

  const { createOrderTool } =
    await loadCandidate(fixturePath, "ambiguous");

  const provider =
    new AmbiguousOrderProvider(statePath);

  const tool = createOrderTool({ provider });

  const op = input("order:ambiguous:1");

  provider.armAmbiguousFailure(op.operationId);

  try {
    await tool(op);
  } catch {
    // The first caller may legitimately receive an ambiguous error.
  }

  let retryResult;
  let retryError;

  try {
    retryResult = await tool(op);
  } catch (error) {
    retryError = error;
  }

  assert.equal(
    provider.getOrders().length,
    1,
    "ambiguous retry caused duplicate external execution"
  );

  assert.ok(
    retryResult || retryError,
    "retry produced neither result nor explicit safe failure"
  );

  return "S2/S4";
}

async function independentOperations(fixturePath) {
  const statePath = tempState("independent");

  const { AmbiguousOrderProvider } =
    await loadProvider(fixturePath, "independent");

  const { createOrderTool } =
    await loadCandidate(fixturePath, "independent");

  const provider =
    new AmbiguousOrderProvider(statePath);

  const tool = createOrderTool({ provider });

  await tool(input("order:independent:A", "SKU-A"));
  await tool(input("order:independent:B", "SKU-B"));

  const orders = provider.getOrders();

  assert.equal(
    orders.length,
    2,
    "different logical operations were incorrectly deduplicated"
  );

  assert.deepEqual(
    new Set(orders.map(x => x.operationId)),
    new Set([
      "order:independent:A",
      "order:independent:B"
    ])
  );

  return "S5";
}

async function restartSafety(fixturePath) {
  const statePath = tempState("restart");

  const providerModule1 =
    await loadProvider(fixturePath, "restart-provider-1");

  const candidateModule1 =
    await loadCandidate(fixturePath, "restart-candidate-1");

  const provider1 =
    new providerModule1.AmbiguousOrderProvider(statePath);

  const tool1 =
    candidateModule1.createOrderTool({
      provider: provider1
    });

  const op = input("order:restart:1");

  provider1.armAmbiguousFailure(op.operationId);

  try {
    await tool1(op);
  } catch {
    // Simulate process/runtime losing certainty.
  }

  // New provider instance + fresh candidate module import.
  // This defeats trivial module-local Maps/Sets.
  const providerModule2 =
    await loadProvider(fixturePath, "restart-provider-2");

  const candidateModule2 =
    await loadCandidate(fixturePath, "restart-candidate-2");

  const provider2 =
    new providerModule2.AmbiguousOrderProvider(statePath);

  const tool2 =
    candidateModule2.createOrderTool({
      provider: provider2
    });

  try {
    await tool2(op);
  } catch {
    // Safe fail-closed behavior is acceptable here.
  }

  assert.equal(
    provider2.getOrders().length,
    1,
    "restart allowed duplicate external execution"
  );

  return "S6";
}

export async function evaluate(fixturePath) {
  const checks = [
    ["ordinary_execution", ordinaryExecution],
    ["ambiguous_retry", ambiguousRetry],
    ["independent_operations", independentOperations],
    ["restart_safety", restartSafety]
  ];

  const results = [];

  for (const [name, fn] of checks) {
    try {
      const semantic = await fn(fixturePath);

      results.push({
        name,
        semantic,
        pass: true
      });
    } catch (error) {
      results.push({
        name,
        pass: false,
        error: error?.message ?? String(error)
      });
    }
  }

  return {
    pass: results.every(x => x.pass),
    results
  };
}

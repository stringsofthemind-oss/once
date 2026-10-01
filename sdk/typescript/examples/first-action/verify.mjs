import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Once, protectLocal } from "@once-agent/sdk";

// A controlled provider ledger, separate from Once's state. No network, real
// orders, payment credentials or project files are involved.
const freshProcess = process.argv[2] === "--replay-child";
const directory = freshProcess ? process.argv[3] : mkdtempSync(path.join(os.tmpdir(), "once-first-action-"));
const effectsPath = path.join(directory, "provider-effects.json");
const intentPath = path.join(directory, "persisted-intent.json");
const statePath = path.join(directory, "operations.sqlite");
const effects = () => JSON.parse(readFileSync(effectsPath, "utf8"));
const effect = ({ account, sku, quantity }) => ({ account, sku, quantity });
const identity = ({ account, intentId }) => Once.id("sandbox", account, "create-order", intentId);
let loseAcknowledgement = false; // Transport fault, not business identity.
let truthAvailable = false;

const createOrder = protectLocal(async input => {
  const rows = effects();
  const receipt = { orderId: `order-${rows.length + 1}`, ...effect(input) };
  rows.push({ id: identity(input), effect: effect(input), receipt });
  writeFileSync(effectsPath, JSON.stringify(rows));
  if (loseAcknowledgement) throw new Error("Provider committed; acknowledgement lost");
  return receipt;
}, {
  statePath,
  id: identity,
  payload: effect,
  reconcile({ id, payload }) {
    if (!truthAvailable) return { state: "UNKNOWN" };
    const matches = effects().filter(row => row.id === id);
    if (matches.length !== 1) return { state: "UNKNOWN" };
    assert.deepEqual(matches[0].effect, payload);
    return { state: "CONFIRMED", result: matches[0].receipt };
  },
});

if (freshProcess) {
  // If redispatched, this provider would append another effect.
  const persisted = JSON.parse(readFileSync(intentPath, "utf8"));
  assert.deepEqual(await createOrder(persisted), effects()[2].receipt);
  assert.equal(effects().length, 3);
  console.log("Fresh process: original receipt replayed, 3 effects retained");
} else {
  try {
    writeFileSync(effectsPath, "[]");
    const first = { intentId: "checkout-1042", account: "shop-1", sku: "widget", quantity: 1 };
    // Durable business requests, not generated model/framework call IDs.
    writeFileSync(intentPath, JSON.stringify(first));
    const receipt = await createOrder(first);
    assert.deepEqual(await createOrder(first), receipt);
    assert.equal(effects().length, 1);
    console.log("First execution + replay: 1 effect");

    await assert.rejects(createOrder({ ...first, quantity: 2 }), { code: "CONFLICT" });
    assert.equal(effects().length, 1);
    console.log("Changed effect under original intent: CONFLICT, no write");

    const second = { ...first, intentId: "checkout-1043" };
    writeFileSync(intentPath, JSON.stringify(second));
    await createOrder(second);
    assert.equal(effects().length, 2);
    console.log("Separate intent, identical effect: 2 effects");

    const uncertain = { ...first, intentId: "checkout-1044" };
    writeFileSync(intentPath, JSON.stringify(uncertain));
    loseAcknowledgement = true;
    await assert.rejects(createOrder(uncertain), { code: "UNKNOWN" });
    loseAcknowledgement = false;
    await assert.rejects(createOrder(uncertain), { code: "UNKNOWN" });
    assert.equal(effects().length, 3);
    console.log("Lost acknowledgement + unavailable truth: UNKNOWN, 3 effects");

    truthAvailable = true;
    assert.deepEqual(await createOrder(uncertain), effects()[2].receipt);
    assert.deepEqual(await createOrder(uncertain), effects()[2].receipt);
    assert.equal(effects().length, 3);
    console.log("Read-only provider truth: recovered original receipt, no redispatch");

    const restarted = spawnSync(process.execPath,
      [fileURLToPath(import.meta.url), "--replay-child", directory],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.equal(restarted.status, 0, restarted.error?.message ?? restarted.stderr);
    assert.equal(effects().length, 3);
    console.log(restarted.stdout.trim());
    console.log("FIRST ACTION PROOF: PASS (simulated provider; same-machine SQLite only)");
  } finally {
    // Delete only the fresh disposable fixture. Never clear production state.
    rmSync(directory, { recursive: true, force: true });
  }
}

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  connectLocalAgentTool,
  AgentToolConnectionError,
  LocalProtectionError,
} from "../../dist/index.js";

const protectedSafety = {
  changesExternalState: true,
  retryPossible: true,
  ambiguousOutcomePossible: true,
  duplicateUndesirable: true,
};
const localReady = Number(process.versions.node.split(".")[0]) > 24 ||
  (Number(process.versions.node.split(".")[0]) === 24 && Number(process.versions.node.split(".")[1]) >= 15);

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "once-agent-tool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    statePath: path.join(dir, "state.sqlite"),
    effectsPath: path.join(dir, "effects.json"),
  };
}

function effect(file, value) {
  let rows = [];
  try { rows = JSON.parse(readFileSync(file, "utf8")); } catch { /* First write. */ }
  rows.push(value);
  writeFileSync(file, JSON.stringify(rows));
}

function count(file) {
  return JSON.parse(readFileSync(file, "utf8")).length;
}

test("normal agent tool calls automatically use one local protected effect per intent", { skip: !localReady }, async (t) => {
  const f = fixture(t);
  const provider = {
    prefix: "booking",
    async execute(input) {
      effect(f.effectsPath, { intent: input.intent, seat: input.seat });
      return { receipt: `${this.prefix}-${count(f.effectsPath)}` };
    },
  };
  const connected = connectLocalAgentTool(provider, {
    name: "book_seat",
    safety: protectedSafety,
    id: input => input.intent,
    payload: input => ({ seat: input.seat }),
    statePath: f.statePath,
  });

  assert.deepEqual(await connected.execute({ intent: "A", seat: "42" }), { receipt: "booking-1" });
  assert.deepEqual(await connected.execute({ intent: "A", seat: "42" }), { receipt: "booking-1" });
  assert.deepEqual(await connected.execute({ intent: "B", seat: "42" }), { receipt: "booking-2" });
  await assert.rejects(
    connected.execute({ intent: "A", seat: "43" }),
    error => error instanceof LocalProtectionError && error.code === "CONFLICT",
  );
  assert.equal(count(f.effectsPath), 2);
});

test("effect then lost acknowledgement blocks retries until provider truth confirms", { skip: !localReady }, async (t) => {
  const f = fixture(t);
  let truthAvailable = false;
  const connected = connectLocalAgentTool({
    async execute(input) {
      effect(f.effectsPath, input.destination);
      throw new Error("Acknowledgement lost after email was accepted");
    },
  }, {
    name: "send_email",
    safety: protectedSafety,
    id: input => input.intent,
    payload: input => ({ destination: input.destination, body: input.body }),
    statePath: f.statePath,
    reconcile: () => truthAvailable
      ? { state: "CONFIRMED", result: { receipt: "mail-1" } }
      : { state: "UNKNOWN" },
  });
  const input = { intent: "invoice-A", destination: "test@example.invalid", body: "Invoice" };
  await assert.rejects(connected.execute(input), { code: "UNKNOWN" });
  await assert.rejects(connected.execute(input), { code: "UNKNOWN" });
  assert.equal(count(f.effectsPath), 1);
  truthAvailable = true;
  assert.deepEqual(await connected.execute(input), { receipt: "mail-1" });
  assert.equal(count(f.effectsPath), 1);
});

test("an incomplete registered effect cannot execute, while an explicit read bypasses", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const tool = { async execute() { calls += 1; return { ok: true }; } };

  for (const contract of [
    { name: "write", safety: protectedSafety, payload: () => ({ amount: 1 }) },
    { name: "write", safety: { changesExternalState: true } },
  ]) {
    assert.throws(
      () => connectLocalAgentTool(tool, contract),
      error => error instanceof AgentToolConnectionError,
    );
  }
  assert.equal(calls, 0);

  const connected = connectLocalAgentTool(tool, {
    name: "read",
    safety: { ...protectedSafety, changesExternalState: false },
    statePath: f.statePath,
  });
  assert.deepEqual(await connected.execute({}), { ok: true });
  assert.equal(calls, 1);
});

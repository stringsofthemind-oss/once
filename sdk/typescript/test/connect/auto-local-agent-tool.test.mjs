import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AgentToolConnectionError,
  connectLocalAgentToolAuto,
} from "@once-agent/sdk/connect";

const [major, minor] = process.versions.node.split(".").map(Number);
const localReady = major > 24 || (major === 24 && minor >= 15);

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "once-auto-tool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    statePath: path.join(dir, "state.sqlite"),
    effectsPath: path.join(dir, "effects.json"),
  };
}

function appendEffect(file, value) {
  let rows = [];
  try {
    rows = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // First effect.
  }
  rows.push(value);
  writeFileSync(file, JSON.stringify(rows));
}

function countEffects(file) {
  return JSON.parse(readFileSync(file, "utf8")).length;
}

test("automatic read-only routing bypasses Once protection", async () => {
  let calls = 0;
  const tool = {
    async execute(input) {
      calls += 1;
      return { query: input.query, calls };
    },
  };

  const connected = connectLocalAgentToolAuto(tool, {
    descriptor: {
      name: "search_web",
      description: "Search the public web.",
    },
  });

  assert.deepEqual(await connected.execute({ query: "once" }), {
    query: "once",
    calls: 1,
  });
  assert.equal(calls, 1);
});

test("automatic consequential routing still requires an explicit effect payload", () => {
  const tool = {
    async execute() {
      return { ok: true };
    },
  };

  assert.throws(
    () => connectLocalAgentToolAuto(tool, {
      descriptor: {
        name: "send_email",
        description: "Send an email to a recipient.",
      },
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "PROTECTION_REQUIRED",
  );
});

test("UNKNOWN tool semantics refuse automatic connection", () => {
  const tool = {
    async execute() {
      return { ok: true };
    },
  };

  assert.throws(
    () => connectLocalAgentToolAuto(tool, {
      descriptor: {
        name: "frobnicate_account",
      },
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "UNKNOWN_TOOL_SAFETY",
  );
});

test("conflicting metadata refuses automatic connection", () => {
  const tool = {
    async execute() {
      return { ok: true };
    },
  };

  assert.throws(
    () => connectLocalAgentToolAuto(tool, {
      descriptor: {
        name: "send_email",
        annotations: {
          readOnlyHint: true,
        },
      },
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "UNKNOWN_TOOL_SAFETY",
  );
});

test("manual identity remains supported for protected tools", { skip: !localReady }, async (t) => {
  const f = fixture(t);

  const tool = {
    async execute(input) {
      appendEffect(f.effectsPath, {
        intent: input.intent,
        destination: input.destination,
      });
      return { receipt: `mail-${countEffects(f.effectsPath)}` };
    },
  };

  const connected = connectLocalAgentToolAuto(tool, {
    descriptor: {
      name: "send_email",
      description: "Send an email to a recipient.",
    },
    id: input => input.intent,
    payload: input => ({
      destination: input.destination,
      body: input.body,
    }),
    statePath: f.statePath,
  });

  const input = {
    intent: "invoice-42",
    destination: "test@example.invalid",
    body: "Invoice 42",
  };

  assert.deepEqual(await connected.execute(input), { receipt: "mail-1" });
  assert.deepEqual(await connected.execute(input), { receipt: "mail-1" });
  assert.equal(countEffects(f.effectsPath), 1);
});

test("idempotency carrier automatically supplies protected operation identity", { skip: !localReady }, async (t) => {
  const f = fixture(t);

  const tool = {
    async execute(input) {
      appendEffect(f.effectsPath, {
        destination: input.destination,
      });
      return { receipt: `mail-${countEffects(f.effectsPath)}` };
    },
  };

  const connected = connectLocalAgentToolAuto(tool, {
    descriptor: {
      name: "send_email",
      description: "Send an email to a recipient.",
    },
    payload: input => ({
      destination: input.destination,
      body: input.body,
    }),
    statePath: f.statePath,
  });

  const first = {
    idempotencyKey: "invoice-42",
    destination: "test@example.invalid",
    body: "Invoice 42",
    attempt: 1,
  };

  const retry = {
    ...first,
    attempt: 2,
  };

  assert.deepEqual(await connected.execute(first), { receipt: "mail-1" });
  assert.deepEqual(await connected.execute(retry), { receipt: "mail-1" });
  assert.equal(countEffects(f.effectsPath), 1);
});

test("descriptor identityFields can automatically supply composite identity", { skip: !localReady }, async (t) => {
  const f = fixture(t);

  const connected = connectLocalAgentToolAuto({
    async execute(input) {
      appendEffect(f.effectsPath, input.destination);
      return { receipt: `mail-${countEffects(f.effectsPath)}` };
    },
  }, {
    descriptor: {
      name: "send_email",
      description: "Send an email to a recipient.",
      _meta: {
        once: {
          identityFields: ["tenant", "intent"],
        },
      },
    },
    payload: input => ({
      destination: input.destination,
      body: input.body,
    }),
    statePath: f.statePath,
  });

  const first = {
    tenant: "acme",
    intent: "invoice-42",
    destination: "test@example.invalid",
    body: "Invoice 42",
    attempt: 1,
  };

  assert.deepEqual(await connected.execute(first), { receipt: "mail-1" });
  assert.deepEqual(await connected.execute({ ...first, attempt: 9 }), { receipt: "mail-1" });
  assert.equal(countEffects(f.effectsPath), 1);
});

test("missing automatic identity blocks before the side effect", { skip: !localReady }, async (t) => {
  const f = fixture(t);
  let calls = 0;

  const connected = connectLocalAgentToolAuto({
    async execute() {
      calls += 1;
      return { ok: true };
    },
  }, {
    descriptor: {
      name: "send_email",
      description: "Send an email to a recipient.",
    },
    payload: input => ({
      destination: input.destination,
      body: input.body,
    }),
    statePath: f.statePath,
  });

  await assert.rejects(
    connected.execute({
      destination: "test@example.invalid",
      body: "Invoice",
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "IDENTITY_REQUIRED",
  );

  assert.equal(calls, 0);
});

test("conflicting automatic identity carriers block before the side effect", { skip: !localReady }, async (t) => {
  const f = fixture(t);
  let calls = 0;

  const connected = connectLocalAgentToolAuto({
    async execute() {
      calls += 1;
      return { ok: true };
    },
  }, {
    descriptor: {
      name: "charge_customer",
      description: "Charge a customer for an order.",
    },
    payload: input => ({ amount: input.amount }),
    statePath: f.statePath,
  });

  await assert.rejects(
    connected.execute({
      operationId: "charge-A",
      idempotencyKey: "charge-B",
      amount: 100,
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "IDENTITY_CONFLICT",
  );

  assert.equal(calls, 0);
});

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

test("automatic consequential routing still requires stable identity and payload", () => {
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

test("automatic protected tool executes one local effect per stable intent", { skip: !localReady }, async (t) => {
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

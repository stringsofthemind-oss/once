import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AgentToolConnectionError,
  connectLocalAgentToolsetAuto,
} from "@once-agent/sdk/connect";

const [major, minor] = process.versions.node.split(".").map(Number);
const localReady = major > 24 || (major === 24 && minor >= 15);

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "once-toolset-"));
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

function noOpTool(result = { ok: true }) {
  return {
    async execute() {
      return result;
    },
  };
}

test("connects an exact mixed registry and returns the audited plan", async () => {
  const originals = {
    search_web: {
      async execute(input) {
        return { query: input.query };
      },
    },
    send_email: noOpTool({ queued: true }),
  };

  const connected = connectLocalAgentToolsetAuto(originals, {
    manifest: [
      { name: "search_web", description: "Search the public web." },
      { name: "send_email", description: "Send an email to a recipient." },
    ],
  });

  assert.deepEqual(connected.plan.summary, {
    total: 2,
    protect: 1,
    bypass: 1,
    unknown: 0,
  });
  assert.deepEqual(Object.keys(connected.tools), ["search_web", "send_email"]);
  assert.equal(Object.isFrozen(connected), true);
  assert.equal(Object.isFrozen(connected.tools), true);
  assert.equal(Object.getPrototypeOf(connected.tools), null);
  assert.notEqual(connected.tools.search_web, originals.search_web);
  assert.notEqual(connected.tools.send_email, originals.send_email);
  assert.deepEqual(
    await connected.tools.search_web.execute({ query: "once" }),
    { query: "once" },
  );

  assert.equal(Object.isFrozen(originals), false);
  assert.equal(typeof originals.send_email.execute, "function");
});

test("automatic toolset routing suppresses a duplicate protected effect", { skip: !localReady }, async (t) => {
  const f = fixture(t);
  const originals = {
    send_email: {
      async execute(input) {
        appendEffect(f.effectsPath, {
          destination: input.destination,
          body: input.body,
        });
        return { receipt: `mail-${countEffects(f.effectsPath)}` };
      },
    },
  };

  const connected = connectLocalAgentToolsetAuto(originals, {
    manifest: [
      { name: "send_email", description: "Send an email to a recipient." },
    ],
    statePath: f.statePath,
  });

  const input = {
    idempotencyKey: "invoice-42",
    destination: "test@example.invalid",
    body: "Invoice 42",
  };

  assert.deepEqual(await connected.tools.send_email.execute(input), {
    receipt: "mail-1",
  });
  assert.deepEqual(await connected.tools.send_email.execute(input), {
    receipt: "mail-1",
  });
  assert.equal(countEffects(f.effectsPath), 1);
});

test("UNKNOWN safety blocks the whole toolset before wiring", () => {
  assert.throws(
    () => connectLocalAgentToolsetAuto({
      frobnicate_account: noOpTool(),
    }, {
      manifest: [{ name: "frobnicate_account" }],
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "UNKNOWN_TOOLSET_SAFETY",
  );
});

test("missing declared implementation blocks the whole toolset", () => {
  assert.throws(
    () => connectLocalAgentToolsetAuto({
      search_web: noOpTool(),
    }, {
      manifest: [
        { name: "search_web" },
        { name: "send_email" },
      ],
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "MISSING_TOOL_IMPLEMENTATION",
  );
});

test("undeclared executable registry entry is rejected", () => {
  assert.throws(
    () => connectLocalAgentToolsetAuto({
      search_web: noOpTool(),
      send_email: noOpTool(),
    }, {
      manifest: [{ name: "search_web" }],
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "UNDECLARED_TOOL_IMPLEMENTATION",
  );
});

test("duplicate manifest names are rejected before wrapping", () => {
  assert.throws(
    () => connectLocalAgentToolsetAuto({
      search_web: noOpTool(),
    }, {
      manifest: [
        { name: "search_web" },
        { name: "search_web" },
      ],
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "DUPLICATE_TOOL_NAME",
  );
});

test("registry-unsafe manifest names are rejected even when classifiable", () => {
  assert.throws(
    () => connectLocalAgentToolsetAuto({
      "search.web": noOpTool(),
    }, {
      manifest: [{ name: "search.web" }],
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "INVALID_TOOL_NAME",
  );
});

test("OpenAI-style annotations and Once metadata survive shared normalization", async () => {
  const connected = connectLocalAgentToolsetAuto({
    frobnicate_account: {
      async execute(input) {
        return { value: input.value };
      },
    },
  }, {
    manifest: [
      {
        type: "function",
        function: {
          name: "frobnicate_account",
          description: "Inspect account state.",
          parameters: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
        annotations: {
          readOnlyHint: true,
        },
        _meta: {
          once: {
            identityFields: ["operationId"],
          },
        },
      },
    ],
  });

  assert.equal(connected.plan.ready, true);
  assert.equal(connected.plan.summary.bypass, 1);
  assert.equal(connected.plan.entries[0].source, "openai_function");
  assert.deepEqual(
    await connected.tools.frobnicate_account.execute({ value: "A" }),
    { value: "A" },
  );
});

test("override for undeclared tool is rejected", () => {
  assert.throws(
    () => connectLocalAgentToolsetAuto({
      search_web: noOpTool(),
    }, {
      manifest: [{ name: "search_web" }],
      overrides: {
        send_email: {
          id: input => input.intent,
        },
      },
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "UNDECLARED_TOOL_OVERRIDE",
  );
});

test("invalid manifest shape fails closed", () => {
  assert.throws(
    () => connectLocalAgentToolsetAuto({}, {
      manifest: { tools: null },
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "INVALID_TOOL_MANIFEST",
  );
});

test("invalid tool implementation fails before any registry is returned", () => {
  assert.throws(
    () => connectLocalAgentToolsetAuto({
      search_web: {},
    }, {
      manifest: [{ name: "search_web" }],
    }),
    error =>
      error instanceof AgentToolConnectionError &&
      error.code === "INVALID_TOOL_IMPLEMENTATION",
  );
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { protectToolCall } from "../dist/index.js";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "once-tool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "state.sqlite");
  const effectsPath = path.join(dir, "effects.json");
  writeFileSync(effectsPath, "[]");
  const effects = () => JSON.parse(readFileSync(effectsPath, "utf8"));
  const execute = async effect => {
    const receipt = { id: effects().length + 1, body: effect.args.body };
    writeFileSync(effectsPath, JSON.stringify([...effects(), receipt]));
    return receipt;
  };
  const base = { operationId: "comment:217", effect: { tool: "github.account-A.add_comment", args: { repo: "lab", issue: 217, body: "test" } }, statePath, execute };
  return { base, effects, effectsPath, statePath };
}

test("first execution, exact retry, canonical ordering, metadata and payload conflicts", async t => {
  const f = fixture(t);
  const result = await protectToolCall(f.base);
  assert.deepEqual(await protectToolCall({ ...f.base, metadata: { traceId: "new", retry: 9 }, effect: { tool: f.base.effect.tool, args: { body: "test", issue: 217, repo: "lab" } } }), result);
  for (const args of [{ ...f.base.effect.args, body: "changed" }, { ...f.base.effect.args, issue: 218 }, { ...f.base.effect.args, repo: "other" }]) {
    await assert.rejects(protectToolCall({ ...f.base, effect: { ...f.base.effect, args } }), { code: "CONFLICT" });
  }
  await assert.rejects(protectToolCall({ ...f.base, effect: { ...f.base.effect, tool: "github.account-B.add_comment" } }), { code: "CONFLICT" });
  assert.equal(f.effects().length, 1);
});

test("fresh process replays durable receipt without invoking supplied host function", async t => {
  const f = fixture(t);
  const result = await protectToolCall(f.base);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { protectToolCall } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    const result = await protectToolCall({ ...JSON.parse(process.argv[1]), execute: async () => { throw Error('redispatch'); } });
    console.log(JSON.stringify(result));
  `, JSON.stringify(f.base)], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), result);
  assert.equal(f.effects().length, 1);
});

test("lost acknowledgement becomes UNKNOWN, then authoritative confirmation persists", async t => {
  const f = fixture(t);
  const lost = { ...f.base, execute: async effect => { await f.base.execute(effect); throw Error("lost acknowledgement"); } };
  await assert.rejects(protectToolCall(lost), { code: "UNKNOWN" });
  await assert.rejects(protectToolCall(f.base), { code: "UNKNOWN" });
  const recovered = await protectToolCall({ ...f.base, reconcile: ({ operationId, effect }) => {
    assert.equal(operationId, f.base.operationId);
    assert.deepEqual(effect, f.base.effect);
    return { status: "CONFIRMED", result: f.effects()[0] };
  } });
  assert.deepEqual(await protectToolCall(f.base), recovered);
  assert.equal(f.effects().length, 1);
});

for (const status of ["NOT_FOUND", "UNKNOWN", "INVALID", "throw", "malformed"]) {
  test(`reconciliation ${status} never authorizes another dispatch`, async t => {
    const f = fixture(t);
    await assert.rejects(protectToolCall({ ...f.base, execute: async effect => { await f.base.execute(effect); throw Error("lost"); } }), { code: "UNKNOWN" });
    const reconcile = () => {
      if (status === "throw") throw Error("lookup unavailable");
      return status === "malformed" ? { status: "CONFIRMED" } : { status };
    };
    await assert.rejects(protectToolCall({ ...f.base, reconcile }), { code: "UNKNOWN" });
    await assert.rejects(protectToolCall(f.base), { code: "UNKNOWN" });
    assert.equal(f.effects().length, 1);
  });
}

test("exception before any effect is conservatively UNKNOWN and blocks retry", async t => {
  const f = fixture(t);
  await assert.rejects(protectToolCall({ ...f.base, execute: async () => { throw Error("host unavailable before dispatch"); } }), { code: "UNKNOWN" });
  await assert.rejects(protectToolCall(f.base), { code: "UNKNOWN" });
  assert.equal(f.effects().length, 0);
});

test("missing identity and invalid effects fail before dispatch", async t => {
  const f = fixture(t);
  for (const operationId of [undefined, "", "  ", 42]) await assert.rejects(protectToolCall({ ...f.base, operationId }), { code: "IDENTITY_REQUIRED" });
  for (const effect of [undefined, {}, { tool: "", args: {} }, { tool: "tool", args: [] }, { tool: "tool", args: {}, extra: true }]) await assert.rejects(protectToolCall({ ...f.base, effect }));
  for (const args of [{ date: new Date() }, { value: undefined }, { fn() {} }, { get body() { throw Error("getter evaluated"); } }]) await assert.rejects(protectToolCall({ ...f.base, effect: { tool: "tool", args } }), { code: "UNSUPPORTED_VALUE" });
  assert.equal(f.effects().length, 0);
});

test("effect snapshot survives caller mutation during asynchronous state initialization", async t => {
  const f = fixture(t);
  const pending = protectToolCall({ ...f.base, execute: async effect => {
    assert.ok(Object.isFrozen(effect.args));
    assert.throws(() => { effect.args.body = "mutate"; }, TypeError);
    return f.base.execute(effect);
  } });
  f.base.effect.args.body = "later";
  assert.equal((await pending).body, "test");
  assert.equal(f.effects()[0].body, "test");
});

test("concurrent exact calls cannot dispatch twice", async t => {
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const first = protectToolCall({ ...f.base, execute: async effect => { entered(); await gate; return f.base.execute(effect); } });
  await ready;
  try { await assert.rejects(protectToolCall(f.base), { code: "IN_FLIGHT" }); }
  finally { release(); }
  await first;
  assert.equal(f.effects().length, 1);
});

test("abandoned durable claim requires reconciliation, including after restart", async t => {
  const f = fixture(t);
  // Establish the exact fingerprint, then simulate a crash before confirmation.
  await protectToolCall(f.base);
  const db = new DatabaseSync(f.statePath);
  try { db.exec("UPDATE local_operations SET state='CLAIMED',result_json=NULL,lease_until=0"); }
  finally { db.close(); }
  await assert.rejects(protectToolCall(f.base), { code: "UNKNOWN" });
  assert.equal(f.effects().length, 1);
});

test("non-replayable host receipt stays blocked", async t => {
  const f = fixture(t);
  await assert.rejects(protectToolCall({ ...f.base, execute: async effect => { await f.base.execute(effect); return new Map(); } }), { code: "UNREPLAYABLE_RESULT" });
  await assert.rejects(protectToolCall(f.base), { code: "UNKNOWN" });
  assert.equal(f.effects().length, 1);
});

test("hard process exit after host write blocks a fresh process from redispatch", async t => {
  const f = fixture(t);
  const source = `
    import { protectToolCall } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    import { writeFileSync } from 'node:fs';
    const options = JSON.parse(process.argv[1]);
    await protectToolCall({ ...options, leaseMs: 1, execute: async () => {
      writeFileSync(process.argv[2], JSON.stringify([{ id: 1, body: 'test' }]));
      process.exit(71);
    } });
  `;
  const crash = spawnSync(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(f.base), f.effectsPath], { encoding: "utf8" });
  assert.equal(crash.status, 71, crash.stderr);
  const retry = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { protectToolCall } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    const options = JSON.parse(process.argv[1]);
    try { await protectToolCall({ ...options, execute: async () => { throw Error('must not dispatch'); } }); process.exit(1); }
    catch (e) { if (e.code !== 'UNKNOWN') throw e; console.log(e.code); }
  `, JSON.stringify(f.base)], { encoding: "utf8" });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.stdout.trim(), "UNKNOWN");
  assert.equal(f.effects().length, 1);
});

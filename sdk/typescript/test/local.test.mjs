import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { protectLocal, LocalProtectionError } from "../dist/index.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(root, "..", ".local-test");

function fixture(t) {
  mkdirSync(workspace, { recursive: true });
  const dir = mkdtempSync(path.join(workspace, "case-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "state.sqlite");
  const effectsPath = path.join(dir, "effects.json");
  writeFileSync(effectsPath, "[]");
  return { dir, statePath, effectsPath };
}

function count(file) { return JSON.parse(readFileSync(file, "utf8")).length; }
function effect(file, value) {
  const rows = JSON.parse(readFileSync(file, "utf8"));
  rows.push(value);
  writeFileSync(file, JSON.stringify(rows));
}
function wrapped(f, run, options = {}) {
  return protectLocal(run, {
    statePath: f.statePath,
    id: input => input.id,
    payload: input => ({ amount: input.amount }),
    ...options,
  });
}

test("four-case identity and effect count, including representation order", async t => {
  const f = fixture(t);
  const run = wrapped(f, async input => {
    effect(f.effectsPath, input.amount);
    return { receipt: `receipt-${count(f.effectsPath)}` };
  });
  assert.deepEqual(await run({ id: "A", amount: 100 }), { receipt: "receipt-1" });
  assert.deepEqual(await run({ id: "A", amount: 100 }), { receipt: "receipt-1" });
  assert.deepEqual(await run({ id: "B", amount: 100 }), { receipt: "receipt-2" });
  await assert.rejects(run({ id: "A", amount: 125 }), e => e instanceof LocalProtectionError && e.code === "CONFLICT");
  assert.equal(count(f.effectsPath), 2);

  const objectRun = wrapped(f, async input => { effect(f.effectsPath, input.amount); return { ok: true }; }, {
    id: input => input.id,
    payload: input => input.payload,
  });
  await objectRun({ id: "C", payload: { amount: 100, currency: "USD" }, amount: 100 });
  await objectRun({ id: "C", payload: { currency: "USD", amount: 100 }, amount: 100 });
  assert.equal(count(f.effectsPath), 3);
});

test("lost response fails closed, then provider confirmation replays", async t => {
  const f = fixture(t);
  const input = { id: "A", amount: 100 };
  const run = wrapped(f, async () => {
    effect(f.effectsPath, 100);
    throw new Error("response lost after commit");
  });
  await assert.rejects(run(input), { code: "UNKNOWN" });
  await assert.rejects(run(input), { code: "UNKNOWN" });
  assert.equal(count(f.effectsPath), 1);
  const recovered = wrapped(f, async () => { throw new Error("must not dispatch"); }, {
    reconcile: async () => ({ state: "CONFIRMED", result: { receipt: "provider-1" } }),
  });
  assert.deepEqual(await recovered(input), { receipt: "provider-1" });
  assert.deepEqual(await run(input), { receipt: "provider-1" });
  assert.equal(count(f.effectsPath), 1);
});

test("ABSENT, unavailable, and malformed truth never redispatch after ambiguity", async t => {
  const f = fixture(t);
  const input = { id: "A", amount: 100 };
  const first = wrapped(f, async () => { effect(f.effectsPath, 100); throw new Error("lost"); });
  await assert.rejects(first(input), { code: "UNKNOWN" });
  for (const reconcile of [
    () => ({ state: "ABSENT" }),
    () => ({ state: "UNKNOWN" }),
    () => ({ state: "wrong" }),
    () => { throw new Error("provider down"); },
  ]) {
    const run = wrapped(f, async () => { effect(f.effectsPath, 100); return {}; }, { reconcile });
    await assert.rejects(run(input), { code: "UNKNOWN" });
  }
  assert.equal(count(f.effectsPath), 1);
});

test("parallel wrappers sharing a file dispatch once", async t => {
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const one = wrapped(f, async () => { await gate; effect(f.effectsPath, 100); return { ok: true }; });
  const two = wrapped(f, async () => { effect(f.effectsPath, 100); return { ok: true }; });
  const input = { id: "A", amount: 100 };
  const pending = one(input);
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(two(input), { code: "IN_FLIGHT" });
  release();
  await pending;
  assert.deepEqual(await two(input), { ok: true });
  assert.equal(count(f.effectsPath), 1);
});

test("fresh process retry replays durable result", async t => {
  const f = fixture(t);
  const run = wrapped(f, async () => { effect(f.effectsPath, 100); return { ok: true }; });
  await run({ id: "A", amount: 100 });
  const script = `import { protectLocal } from ${JSON.stringify(pathToFileURL(path.resolve(root, "../dist/index.js")).href)};
import { appendFileSync } from "node:fs";
const run = protectLocal(async input => { appendFileSync(${JSON.stringify(f.effectsPath)}, "duplicate"); return {ok:false}; }, {statePath:${JSON.stringify(f.statePath)}, id:input=>input.id, payload:input=>({amount:input.amount})});
console.log(JSON.stringify(await run({id:"A",amount:100})));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), { ok: true });
  assert.equal(count(f.effectsPath), 1);
});

test("hard crash after external commit remains blocked in a fresh process", async t => {
  const f = fixture(t);
  const script = `import { protectLocal } from ${JSON.stringify(pathToFileURL(path.resolve(root, "../dist/index.js")).href)};
import { appendFileSync } from "node:fs";
const run = protectLocal(async input => { appendFileSync(${JSON.stringify(f.effectsPath)}, "x"); process.exit(21); }, {statePath:${JSON.stringify(f.statePath)}, leaseMs:1, id:input=>input.id, payload:input=>({amount:input.amount})});
await run({id:"A",amount:100});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 21, child.stderr);
  assert.equal(readFileSync(f.effectsPath, "utf8"), "[]x");
  const retry = wrapped(f, async () => { throw new Error("must not dispatch"); }, { leaseMs: 1 });
  await assert.rejects(retry({ id: "A", amount: 100 }), { code: "UNKNOWN" });
});

test("crash before provider dispatch remains blocked until truth is known", async t => {
  const f = fixture(t);
  const script = `import { protectLocal } from ${JSON.stringify(pathToFileURL(path.resolve(root, "../dist/index.js")).href)};
const run = protectLocal(async () => process.exit(22), {statePath:${JSON.stringify(f.statePath)}, leaseMs:1, id:input=>input.id, payload:input=>({amount:input.amount})});
await run({id:"A",amount:100});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 22, child.stderr);
  const retry = wrapped(f, async () => { effect(f.effectsPath, 100); return {}; });
  await assert.rejects(retry({ id: "A", amount: 100 }), { code: "UNKNOWN" });
  assert.equal(count(f.effectsPath), 0);
});

test("unavailable state never falls through to the original function", async t => {
  const f = fixture(t);
  const run = wrapped(f, async () => { effect(f.effectsPath, 100); return {}; }, { statePath: f.dir });
  await assert.rejects(run({ id: "A", amount: 100 }), { code: "STATE_UNAVAILABLE" });
  assert.equal(count(f.effectsPath), 0);
});

test("unreplayable result leaves one effect and blocks retry", async t => {
  const f = fixture(t);
  const run = wrapped(f, async () => { effect(f.effectsPath, 100); return new Map([["effect", 1]]); });
  const input = { id: "A", amount: 100 };
  await assert.rejects(run(input), { code: "UNREPLAYABLE_RESULT" });
  await assert.rejects(run(input), { code: "UNKNOWN" });
  assert.equal(count(f.effectsPath), 1);
});

test("concurrent reconciliation returns the durable winner's receipt", async t => {
  const f = fixture(t);
  const input = { id: "A", amount: 100 };
  const first = wrapped(f, async () => { effect(f.effectsPath, 100); throw new Error("lost"); });
  await assert.rejects(first(input), { code: "UNKNOWN" });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const slow = wrapped(f, async () => { throw new Error("must not dispatch"); }, {
    reconcile: async () => { started(); await gate; return { state: "CONFIRMED", result: { receipt: "stale" } }; },
  });
  const fast = wrapped(f, async () => { throw new Error("must not dispatch"); }, {
    reconcile: async () => ({ state: "CONFIRMED", result: { receipt: "winner" } }),
  });
  const pending = slow(input);
  await entered;
  assert.deepEqual(await fast(input), { receipt: "winner" });
  release();
  assert.deepEqual(await pending, { receipt: "winner" });
  assert.equal(count(f.effectsPath), 1);
});

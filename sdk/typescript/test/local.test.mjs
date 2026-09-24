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

test("existing provider-taking tool factory keeps its caller contract", async t => {
  const f = fixture(t);
  const provider = {
    async create({ id, amount }) {
      effect(f.effectsPath, { id, amount });
      return { providerReceipt: id };
    },
  };
  function createTool({ provider }) {
    return {
      execute: protectLocal(input => provider.create(input), {
        statePath: f.statePath,
        id: input => `create:${input.id}`,
        payload: input => ({ id: input.id, amount: input.amount }),
      }),
    };
  }
  const tool = createTool({ provider });
  assert.deepEqual(await tool.execute({ id: "A", amount: 100 }), { providerReceipt: "A" });
  assert.deepEqual(await tool.execute({ id: "A", amount: 100 }), { providerReceipt: "A" });
  assert.equal(count(f.effectsPath), 1);
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

test("F1 immediate and nested argument mutation cannot change dispatched values", async t => {
  const f = fixture(t);
  const run = wrapped(f, async input => {
    effect(f.effectsPath, { amount: input.amount, nested: input.nested.value });
    return { amount: input.amount, nested: input.nested.value };
  }, { payload: input => ({ amount: input.amount, nested: input.nested.value }) });
  const input = { id: "A", amount: 100, nested: { value: "original" } };
  const pending = run(input);
  input.amount = 125;
  input.nested.value = "changed";
  assert.deepEqual(await pending, { amount: 100, nested: "original" });
  assert.deepEqual(JSON.parse(readFileSync(f.effectsPath, "utf8")), [{ amount: 100, nested: "original" }]);
  assert.deepEqual(await run({ id: "A", amount: 100, nested: { value: "original" } }), { amount: 100, nested: "original" });
  await assert.rejects(run(input), { code: "CONFLICT" });
  assert.equal(count(f.effectsPath), 1);
});

test("F1 operation cannot mutate snapshotted consequential data", async t => {
  const f = fixture(t);
  const run = wrapped(f, async input => {
    input.nested.amount = 125;
    effect(f.effectsPath, input.nested.amount);
    return {};
  }, { payload: input => ({ amount: input.nested.amount }) });
  const input = { id: "A", nested: { amount: 100 } };
  await assert.rejects(run(input), { code: "UNKNOWN" });
  await assert.rejects(run(input), { code: "UNKNOWN" });
  assert.equal(count(f.effectsPath), 0);
});

test("F1 reconciliation sees invocation snapshot after caller mutation", async t => {
  const f = fixture(t);
  const first = wrapped(f, async () => { effect(f.effectsPath, 100); throw new Error("lost"); }, {
    payload: input => ({ nested: input.nested }),
  });
  await assert.rejects(first({ id: "A", nested: { amount: 100 } }), { code: "UNKNOWN" });
  let observed;
  const retry = wrapped(f, async () => { throw new Error("must not dispatch"); }, {
    payload: input => ({ nested: input.nested }),
    reconcile: ({ payload }) => {
      observed = payload;
      return { state: "ABSENT" };
    },
  });
  const input = { id: "A", nested: { amount: 100 } };
  const pending = retry(input);
  input.nested.amount = 125;
  await assert.rejects(pending, { code: "UNKNOWN" });
  assert.deepEqual(observed, { nested: { amount: 100 } });
  assert.equal(count(f.effectsPath), 1);
});

test("F2 sparse, accessor, hidden, symbol, and extended payload forms fail before claim", async t => {
  const f = fixture(t);
  const run = wrapped(f, async () => { effect(f.effectsPath, 1); return {}; }, {
    payload: input => ({ items: input.items }),
  });
  for (const items of [
    Array(1),
    Object.defineProperty([], "extra", { value: 1, enumerable: true }),
    Object.defineProperty({}, "hidden", { value: 1 }),
    { [Symbol("hidden")]: 1 },
    Object.defineProperty({}, "value", { get() { throw new Error("getter invoked"); }, enumerable: true }),
    Object.defineProperty({}, "toJSON", { value() { return {}; } }),
    new Proxy({}, { ownKeys() { throw new Error("proxy trap invoked"); } }),
  ]) {
    await assert.rejects(run({ id: "A", items }), { code: "UNSUPPORTED_VALUE" });
  }
  assert.equal(count(f.effectsPath), 0);
  assert.deepEqual(await run({ id: "A", items: [] }), {});
  assert.equal(count(f.effectsPath), 1);
});

test("F3 hidden toJSON and changing getter results leave one uncertain effect", async t => {
  for (const makeResult of [
    () => Object.defineProperty({ receipt: "real" }, "toJSON", { value() { return { receipt: "fake" }; } }),
    () => Object.defineProperty({}, "receipt", { enumerable: true, get() { return "changing"; } }),
  ]) {
    const f = fixture(t);
    const run = wrapped(f, async () => { effect(f.effectsPath, 100); return makeResult(); });
    const input = { id: "A", amount: 100 };
    await assert.rejects(run(input), { code: "UNREPLAYABLE_RESULT" });
    await assert.rejects(run(input), { code: "UNKNOWN" });
    assert.equal(count(f.effectsPath), 1);
  }
});

test("F3 initial success and replay have equivalent observable receipt data", async t => {
  const f = fixture(t);
  const run = wrapped(f, async () => {
    effect(f.effectsPath, 100);
    return { nested: { receipt: "real" }, list: [1, null, "ok"] };
  });
  const input = { id: "A", amount: 100 };
  const initial = await run(input);
  const replay = await run(input);
  assert.deepEqual(initial, replay);
  assert.equal(JSON.stringify(initial), JSON.stringify(replay));
  assert.equal(count(f.effectsPath), 1);
});

test("F4 receiver-dependent method retains dynamic this", async t => {
  const f = fixture(t);
  const object = {
    prefix: "receipt",
    async run(input) {
      effect(f.effectsPath, input.amount);
      return { receipt: `${this.prefix}-${input.amount}` };
    },
  };
  object.run = wrapped(f, object.run);
  assert.deepEqual(await object.run({ id: "A", amount: 100 }), { receipt: "receipt-100" });
  assert.deepEqual(await object.run({ id: "A", amount: 100 }), { receipt: "receipt-100" });
  assert.equal(count(f.effectsPath), 1);
});

test("provider handle in an argument retains identity while data is snapshotted", async t => {
  const f = fixture(t);
  const provider = {
    async create(input) {
      effect(f.effectsPath, input.amount);
      return { receipt: "provider" };
    },
  };
  const run = wrapped(f, async input => {
    assert.equal(input.provider, provider);
    return input.provider.create({ amount: input.amount });
  });
  const input = { id: "A", amount: 100, provider };
  const pending = run(input);
  input.amount = 125;
  assert.deepEqual(await pending, { receipt: "provider" });
  assert.deepEqual(JSON.parse(readFileSync(f.effectsPath, "utf8")), [100]);
});

test("live operation beyond lease expiry blocks retry and loses confirmation right", async t => {
  const f = fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const first = wrapped(f, async () => {
    entered();
    await gate;
    effect(f.effectsPath, 100);
    return { receipt: "late" };
  }, { leaseMs: 1 });
  const retry = wrapped(f, async () => { effect(f.effectsPath, "duplicate"); return {}; }, {
    leaseMs: 1,
    reconcile: () => ({ state: "ABSENT" }),
  });
  const input = { id: "A", amount: 100 };
  const pending = first(input);
  await started;
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(retry(input), { code: "UNKNOWN" });
  release();
  await assert.rejects(pending, { code: "EXECUTION_RIGHT_LOST" });
  assert.deepEqual(JSON.parse(readFileSync(f.effectsPath, "utf8")), [100]);
});

test("malformed persisted receipt blocks replay without dispatch", async t => {
  const f = fixture(t);
  const run = wrapped(f, async () => { effect(f.effectsPath, 100); return { receipt: "real" }; });
  const input = { id: "A", amount: 100 };
  await run(input);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(f.statePath);
  db.prepare("UPDATE local_operations SET result_json=? WHERE id=?").run('{"hasValue":true,"value":{"receipt":1', "A");
  db.close();
  await assert.rejects(run(input), { code: "STATE_UNAVAILABLE" });
  assert.equal(count(f.effectsPath), 1);
});

test("corrupt SQLite state blocks dispatch", async t => {
  const f = fixture(t);
  writeFileSync(f.statePath, "not a SQLite database");
  const run = wrapped(f, async () => { effect(f.effectsPath, 100); return {}; });
  await assert.rejects(run({ id: "A", amount: 100 }), { code: "STATE_UNAVAILABLE" });
  assert.equal(count(f.effectsPath), 0);
});

test("claim failure and confirmation write failure never fall through to another effect", async t => {
  const f = fixture(t);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(f.statePath);
  db.exec("CREATE TABLE local_operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('CLAIMED','UNKNOWN','CONFIRMED')), result_json TEXT, owner TEXT, lease_until INTEGER)");
  db.exec("CREATE TRIGGER reject_claim BEFORE INSERT ON local_operations BEGIN SELECT RAISE(ABORT, 'claim failed'); END");
  db.close();
  const run = wrapped(f, async () => { effect(f.effectsPath, 100); return { ok: true }; }, { leaseMs: 1 });
  const input = { id: "A", amount: 100 };
  await assert.rejects(run(input), { code: "STATE_UNAVAILABLE" });
  assert.equal(count(f.effectsPath), 0);
  const db2 = new DatabaseSync(f.statePath);
  db2.exec("DROP TRIGGER reject_claim");
  db2.exec("CREATE TRIGGER reject_confirmation BEFORE UPDATE OF state ON local_operations WHEN NEW.state='CONFIRMED' BEGIN SELECT RAISE(ABORT, 'confirmation failed'); END");
  db2.close();
  await assert.rejects(run(input));
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(run(input), { code: "UNKNOWN" });
  assert.equal(count(f.effectsPath), 1);
});

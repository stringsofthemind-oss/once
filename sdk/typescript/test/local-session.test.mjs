import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createLocalProtectionSession,
  withLocalProtectionSession,
} from "../dist/connect/index.js";
import {
  LocalProtectionError,
  protectLocal,
} from "../dist/local.js";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "once-local-session-"));
  const statePath = path.join(dir, "state.sqlite");
  const effectsPath = path.join(dir, "effects.json");
  writeFileSync(effectsPath, "[]");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, statePath, effectsPath };
}

function count(pathname) {
  return JSON.parse(readFileSync(pathname, "utf8")).length;
}

function addEffect(pathname, value) {
  const rows = JSON.parse(readFileSync(pathname, "utf8"));
  rows.push(value);
  writeFileSync(pathname, JSON.stringify(rows));
}

function createRun(f) {
  return protectLocal(async input => {
    addEffect(f.effectsPath, input.amount);
    return { receipt: `r-${count(f.effectsPath)}` };
  }, {
    statePath: f.statePath,
    id: input => input.id,
    payload: input => ({ amount: input.amount }),
  });
}

test("scoped persistent state preserves replay and conflict semantics", async t => {
  const f = fixture(t);
  const session = createLocalProtectionSession(f.statePath);
  t.after(() => session.close());
  const run = createRun(f);

  const first = await withLocalProtectionSession(session,
    () => run({ id: "A", amount: 100 }));
  assert.deepEqual(first, { receipt: "r-1" });
  assert.deepEqual(await withLocalProtectionSession(session,
    () => run({ id: "A", amount: 100 })), first);
  await assert.rejects(
    withLocalProtectionSession(session,
      () => run({ id: "A", amount: 125 })),
    error => error instanceof LocalProtectionError && error.code === "CONFLICT",
  );
  assert.equal(count(f.effectsPath), 1);
});

test("scoped session fails closed when its durable state path disappears", async t => {
  const f = fixture(t);
  const session = createLocalProtectionSession(f.statePath);
  t.after(() => session.close());
  const run = createRun(f);

  await withLocalProtectionSession(session,
    () => run({ id: "A", amount: 100 }));
  assert.equal(count(f.effectsPath), 1);

  unlinkSync(f.statePath);
  await assert.rejects(
    withLocalProtectionSession(session,
      () => run({ id: "B", amount: 200 })),
    error => error instanceof LocalProtectionError && error.code === "STATE_UNAVAILABLE",
  );
  assert.equal(count(f.effectsPath), 1);

  // Once invalidated, recreating a file at the same pathname cannot silently
  // reactivate this live execution boundary.
  writeFileSync(f.statePath, "replacement");
  await assert.rejects(
    withLocalProtectionSession(session,
      () => run({ id: "C", amount: 300 })),
    error => error instanceof LocalProtectionError && error.code === "STATE_UNAVAILABLE",
  );
  assert.equal(count(f.effectsPath), 1);
});

test("in-place state corruption blocks a new effect with a live session", async t => {
  const f = fixture(t);
  const session = createLocalProtectionSession(f.statePath);
  t.after(() => session.close());
  const run = createRun(f);

  await withLocalProtectionSession(session,
    () => run({ id: "A", amount: 100 }));
  assert.equal(count(f.effectsPath), 1);

  // Same pathname/inode, corrupted contents. SQLite itself must reject the
  // atomic claim before another external effect can run.
  writeFileSync(f.statePath, "not-a-sqlite-database");
  await assert.rejects(
    withLocalProtectionSession(session,
      () => run({ id: "B", amount: 200 })),
    error => error instanceof LocalProtectionError && error.code === "STATE_UNAVAILABLE",
  );
  assert.equal(count(f.effectsPath), 1);
});

test("corruption after an external effect cannot cause a blind redispatch", async t => {
  const f = fixture(t);
  const session = createLocalProtectionSession(f.statePath);
  t.after(() => session.close());
  const run = protectLocal(async input => {
    addEffect(f.effectsPath, input.amount);
    // Adversarially corrupt the same live database file after the effect but
    // before Once can durably confirm its receipt.
    writeFileSync(f.statePath, "corrupt-after-effect");
    return { receipt: "ambiguous" };
  }, {
    statePath: f.statePath,
    id: input => input.id,
    payload: input => ({ amount: input.amount }),
  });

  await assert.rejects(withLocalProtectionSession(session,
    () => run({ id: "A", amount: 100 })));
  assert.equal(count(f.effectsPath), 1);

  await assert.rejects(withLocalProtectionSession(session,
    () => run({ id: "A", amount: 100 })));
  assert.equal(count(f.effectsPath), 1);
});

test("an unrelated scoped session cannot change a protectLocal state path", async t => {
  const f = fixture(t);
  const other = path.join(f.dir, "other.sqlite");
  const session = createLocalProtectionSession(other);
  t.after(() => session.close());
  const run = createRun(f);

  assert.deepEqual(await withLocalProtectionSession(session,
    () => run({ id: "A", amount: 100 })), { receipt: "r-1" });
  assert.equal(count(f.effectsPath), 1);
});

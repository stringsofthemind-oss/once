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
  const sessions = [];
  // Hooks run in registration order: release SQLite handles before deletion.
  t.after(() => {
    for (const session of sessions) session.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, statePath, effectsPath, session(location = statePath) {
    const session = createLocalProtectionSession(location);
    sessions.push(session);
    return session;
  } };
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

async function settle(callback) {
  return (await Promise.allSettled([callback()]))[0];
}

test("scoped persistent state preserves replay and conflict semantics", async t => {
  const f = fixture(t);
  const session = f.session();
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
  const session = f.session();
  t.after(() => session.close());
  const run = createRun(f);

  await withLocalProtectionSession(session,
    () => run({ id: "A", amount: 100 }));
  assert.equal(count(f.effectsPath), 1);

  if (process.platform === "win32") {
    assert.throws(() => unlinkSync(f.statePath), e => e.code === "EBUSY" || e.code === "EPERM");
    assert.deepEqual(await withLocalProtectionSession(session,
      () => run({ id: "A", amount: 100 })), { receipt: "r-1" });
    assert.equal(count(f.effectsPath), 1);
    return;
  }
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

test("same-inode main-file damage cannot lose a confirmed effect across restart", async t => {
  const f = fixture(t);
  const session = f.session();
  const run = createRun(f);

  await withLocalProtectionSession(session,
    () => run({ id: "A", amount: 100 }));
  assert.equal(count(f.effectsPath), 1);

  // WAL mode may legitimately keep operating after damage to the main DB file.
  // The safety invariant is durable: after closing/reopening, the same logical
  // operation must replay or fail closed rather than create another effect.
  writeFileSync(f.statePath, "not-a-sqlite-database");
  session.close();

  const restarted = f.session();
  t.after(() => restarted.close());
  await settle(() => withLocalProtectionSession(restarted,
    () => run({ id: "A", amount: 100 })));
  assert.equal(count(f.effectsPath), 1);
});

test("damage after an external effect cannot cause a blind redispatch after restart", async t => {
  const f = fixture(t);
  const session = f.session();
  const run = protectLocal(async input => {
    addEffect(f.effectsPath, input.amount);
    // Damage the same live main database file after the effect but before Once
    // confirms the receipt. WAL may allow confirmation or force a failure; both
    // are acceptable only if a fresh-process-style retry never executes again.
    writeFileSync(f.statePath, "damage-after-effect");
    return { receipt: "ambiguous" };
  }, {
    statePath: f.statePath,
    id: input => input.id,
    payload: input => ({ amount: input.amount }),
  });

  await settle(() => withLocalProtectionSession(session,
    () => run({ id: "A", amount: 100 })));
  assert.equal(count(f.effectsPath), 1);
  session.close();

  const restarted = f.session();
  t.after(() => restarted.close());
  await settle(() => withLocalProtectionSession(restarted,
    () => run({ id: "A", amount: 100 })));
  assert.equal(count(f.effectsPath), 1);
});

test("an unrelated scoped session cannot change a protectLocal state path", async t => {
  const f = fixture(t);
  const other = path.join(f.dir, "other.sqlite");
  const session = f.session(other);
  t.after(() => session.close());
  const run = createRun(f);

  assert.deepEqual(await withLocalProtectionSession(session,
    () => run({ id: "A", amount: 100 })), { receipt: "r-1" });
  assert.equal(count(f.effectsPath), 1);
});

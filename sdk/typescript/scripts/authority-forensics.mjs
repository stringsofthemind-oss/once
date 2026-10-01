import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// A provider simulator, not a replacement Once implementation. Real Once
// executes every action. Independent provider files survive authority loss.
const script = fileURLToPath(import.meta.url);
const sdk = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const now = () => new Date().toISOString();
function inspect(file) {
  if (!existsSync(file)) return { exists: false, rows: [] };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all();
    return { exists: true, userVersion: db.prepare('PRAGMA user_version').get(), tables,
      rows: tables.some(table => table.name === 'local_operations')
        ? db.prepare('SELECT * FROM local_operations ORDER BY id').all() : [] };
  } finally { db.close(); }
}
if (process.argv[2] === '--child') {
  const [directory, identity, native] = process.argv.slice(3);
  const { protectLocal } = await import(pathToFileURL(sdk).href);
  const statePath = join(directory, 'authority', 'state.sqlite');
  const providerFile = join(directory, 'provider.json');
  const traceFile = join(directory, 'calls.json');
  const trace = event => { const rows = read(traceFile); rows.push({ ...event, pid: process.pid, utc: now() }); writeFileSync(traceFile, JSON.stringify(rows)); };
  const payload = { account: 'sandbox-account', amount: 100, currency: 'GBP' };
  const run = protectLocal(async input => {
    trace({ type: 'provider-dispatch', identity, payload });
    const rows = read(providerFile);
    if (native === 'native') {
      const existing = rows.find(row => row.identity === input.identity);
      if (existing) { assert.deepEqual(existing.payload, payload); return existing.receipt; }
    }
    const receipt = { effectNumber: rows.length + 1 };
    rows.push({ identity: input.identity, payload, receipt, committedUtc: now(), pid: process.pid });
    writeFileSync(providerFile, JSON.stringify(rows));
    return receipt;
  }, { statePath, id: input => input.identity, payload: () => payload,
    reconcile({ id, payload: effect }) {
      trace({ type: 'reconciliation-read', identity: id });
      const matches = read(providerFile).filter(row => row.identity === id);
      return matches.length === 1 && JSON.stringify(matches[0].payload) === JSON.stringify(effect)
        ? { state: 'CONFIRMED', result: matches[0].receipt } : { state: 'UNKNOWN' };
    },
  });
  const before = inspect(statePath);
  const startedUtc = now();
  const result = await run({ identity });
  console.log(JSON.stringify({ pid: process.pid, identity, payload, startedUtc, endedUtc: now(), before, result, after: inspect(statePath) }));
} else {
  const root = mkdtempSync(join(tmpdir(), 'once-authority-forensics-'));
  const scenarios = [];
  function fixture(name) {
    const dir = join(root, name); mkdirSync(join(dir, 'authority'), { recursive: true });
    writeFileSync(join(dir, 'provider.json'), '[]'); writeFileSync(join(dir, 'calls.json'), '[]');
    return dir;
  }
  function call(dir, id = 'persisted-intent-A', native = '') {
    const r = spawnSync(process.execPath, [script, '--child', dir, id, native], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(r.status, 0, r.error?.message ?? r.stderr);
    return JSON.parse(r.stdout.trim());
  }
  function snapshot(dir) {
    const target = join(dir, 'snapshot.sqlite'); const startedUtc = now();
    const db = new DatabaseSync(join(dir, 'authority', 'state.sqlite'));
    try { db.prepare('VACUUM INTO ?').run(target); } finally { db.close(); }
    return { startedUtc, endedUtc: now(), content: inspect(target) };
  }
  function lose(dir, restore = false) {
    const authority = resolve(dir, 'authority');
    assert.equal(dirname(authority), resolve(dir));
    const before = inspect(join(authority, 'state.sqlite')); const startedUtc = now();
    rmSync(authority, { recursive: true, force: true }); mkdirSync(authority);
    if (restore) copyFileSync(join(dir, 'snapshot.sqlite'), join(authority, 'state.sqlite'));
    return { before, startedUtc, endedUtc: now(), after: inspect(join(authority, 'state.sqlite')) };
  }
  try {
    for (const mode of ['stale', 'loss', 'current', 'native-loss']) {
      const dir = fixture(mode); const initial = { utc: now(), authority: inspect(join(dir, 'authority', 'state.sqlite')), provider: read(join(dir, 'provider.json')) };
      let olderAction; let backup;
      if (mode === 'stale') {
        // Historically correct retained B makes the snapshot valid, yet stale
        // with respect to subsequent A. It is not corruption or an empty fake.
        olderAction = call(dir, 'persisted-intent-B'); backup = snapshot(dir);
      }
      const first = call(dir, 'persisted-intent-A', mode === 'native-loss' ? 'native' : '');
      assert.equal(first.after.rows.find(row => row.id === 'persisted-intent-A').state, 'CONFIRMED');
      if (mode === 'current') backup = snapshot(dir);
      const providerBeforeRestore = read(join(dir, 'provider.json'));
      const restoration = lose(dir, mode === 'stale' || mode === 'current');
      const retry = call(dir, 'persisted-intent-A', mode === 'native-loss' ? 'native' : '');
      const providerFinal = read(join(dir, 'provider.json')); const calls = read(join(dir, 'calls.json'));
      const actionEffects = providerFinal.filter(row => row.identity === 'persisted-intent-A');
      const duplicate = mode === 'stale' || mode === 'loss';
      assert.equal(actionEffects.length, duplicate ? 2 : 1);
      assert.equal(calls.filter(row => row.type === 'reconciliation-read').length, 0,
        'Missing rows and CONFIRMED replay do not invoke recovery');
      assert.deepEqual(actionEffects.map(row => row.payload), Array(actionEffects.length).fill(first.payload));
      if (duplicate) assert.notDeepEqual(retry.result, first.result);
      else assert.deepEqual(retry.result, first.result);
      if (mode === 'stale') {
        assert.ok(restoration.after.rows.some(row => row.id === 'persisted-intent-B'));
        assert.ok(!restoration.after.rows.some(row => row.id === 'persisted-intent-A'));
      }
      scenarios.push({ mode, initial, olderAction, snapshot: backup ?? null,
        first, providerBeforeRestore, restoration, retry, providerFinal, calls,
        targetEffectCount: actionEffects.length, reconciliationReads: 0,
        guarantee: mode === 'native-loss' ? 'SIMULATED atomic provider dedup survives local loss; not a real-provider certification' : 'current retained-authority boundary' });
    }
    console.log(JSON.stringify({ node: process.version, os: process.platform,
      sdkVersion: read(fileURLToPath(new URL('../package.json', import.meta.url))).version,
      provider: 'independent disposable simulated provider; no external writes', scenarios }, null, 2));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

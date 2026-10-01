import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Disposable provider ledger is independent of SQLite authority. This is
// controlled evidence, never a claim about a real external provider.
const script = fileURLToPath(import.meta.url);
if (process.argv[2] === '--child') {
  const [directory, mode, implementation] = process.argv.slice(3);
  const { protectLocal } = await import(pathToFileURL(implementation).href);
  const ledger = join(directory, 'provider.json');
  const rows = () => JSON.parse(readFileSync(ledger, 'utf8'));
  const run = protectLocal(async input => {
    const records = rows(); const result = { receipt: records.length + 1 };
    records.push({ id: input.id, amount: input.amount, result });
    writeFileSync(ledger, JSON.stringify(records));
    if (mode === 'lost') throw Error('acknowledgement lost after commit');
    if (mode === 'crash') process.exit(73);
    return result;
  }, { statePath: join(directory, 'state.sqlite'), leaseMs: 1,
    id: input => input.id, payload: input => ({ amount: input.amount }),
    reconcile({ id, payload }) {
      if (mode === 'interrupt-recovery') process.exit(74);
      if (mode === 'unavailable') throw Error('provider unavailable');
      if (mode === 'absent') return { state: 'ABSENT' };
      const matches = rows().filter(row => row.id === id && row.amount === payload.amount);
      return matches.length === 1 ? { state: 'CONFIRMED', result: matches[0].result } : { state: 'UNKNOWN' };
    },
  });
  try { console.log(JSON.stringify({ outcome: 'CONFIRMED', result: await run({ id: 'persisted-intent-A', amount: 100 }) })); }
  catch (error) { console.log(JSON.stringify({ outcome: error.code ?? 'ERROR' })); }
} else {
  const implementation = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const prior = process.env.ONCE_PRIOR_IMPLEMENTATION;
  const root = mkdtempSync(join(tmpdir(), 'once-continuity-'));
  const evidence = [];
  const fixture = name => { const directory = join(root, name); mkdirSync(directory); writeFileSync(join(directory, 'provider.json'), '[]'); return directory; };
  const count = directory => JSON.parse(readFileSync(join(directory, 'provider.json'), 'utf8')).length;
  function call(directory, mode = 'normal', source = implementation) {
    const child = spawnSync(process.execPath, [script, '--child', directory, mode, source], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (mode === 'crash' || mode === 'interrupt-recovery') { assert.equal(child.status, mode === 'crash' ? 73 : 74, child.stderr); return { outcome: 'PROCESS_EXIT', exit: child.status }; }
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    return JSON.parse(child.stdout.trim());
  }
  function record(scenario, directory, result, expectedCount, classification) {
    assert.equal(count(directory), expectedCount);
    evidence.push({ scenario, observed: result, providerLedgerEffects: count(directory), classification, provider: 'controlled independent file ledger; NOT real external provider' });
  }
  try {
    const normal = fixture('normal'); const first = call(normal);
    assert.deepEqual(call(normal), first); record('A restart', normal, first, 1, 'SUPPORTED BUT BOUNDED');
    // Calls close their database before backup. VACUUM INTO uses SQLite's
    // snapshot mechanism, rather than a potentially incomplete WAL main copy.
    const { DatabaseSync } = await import('node:sqlite');
    const snapshot = directory => { const db = new DatabaseSync(join(directory, 'state.sqlite')); const backup = join(directory, 'backup.sqlite'); db.prepare('VACUUM INTO ?').run(backup); db.close(); return backup; };
    const removeState = directory => { for (const suffix of ['', '-wal', '-shm']) { const file = join(directory, `state.sqlite${suffix}`); if (existsSync(file)) rmSync(file); } };
    const backup = snapshot(normal); removeState(normal); copyFileSync(backup, join(normal, 'state.sqlite'));
    assert.deepEqual(call(normal), first); record('B current SQLite snapshot restore', normal, first, 1, 'SUPPORTED BUT BOUNDED');
    if (prior) {
      const upgrade = fixture('upgrade'); const old = call(upgrade, 'normal', prior);
      assert.deepEqual(call(upgrade), old); record('E public 0.1.22 to candidate upgrade', upgrade, old, 1, 'SUPPORTED BUT BOUNDED');
      assert.deepEqual(call(upgrade, 'normal', prior), old); record('C rollback retaining authority', upgrade, old, 1, 'SUPPORTED BUT BOUNDED');
    } else evidence.push({ scenario: 'C/E upgrade and rollback', classification: 'NOT EXECUTED — prior implementation unavailable' });
    const loss = fixture('loss'); call(loss); removeState(loss);
    record('D closed-process complete authority loss', loss, call(loss), 2, 'DEMONSTRATED LIMITATION: recreated authority redispatches');
    const stale = fixture('stale'); const empty = new DatabaseSync(join(stale, 'state.sqlite')); empty.exec('PRAGMA user_version=0'); empty.close();
    const staleBackup = snapshot(stale); call(stale); removeState(stale); copyFileSync(staleBackup, join(stale, 'state.sqlite'));
    record('B stale pre-effect snapshot restore', stale, call(stale), 2, 'DEMONSTRATED LIMITATION: rollback omits committed effect');
    const recovery = fixture('recovery'); assert.equal(call(recovery, 'lost').outcome, 'UNKNOWN');
    call(recovery, 'interrupt-recovery'); assert.equal(call(recovery, 'unavailable').outcome, 'UNKNOWN');
    record('F interrupted read-only recovery; G unavailable truth', recovery, { outcome: 'UNKNOWN' }, 1, 'SUPPORTED BUT BOUNDED');
    assert.equal(call(recovery, 'absent').outcome, 'UNKNOWN');
    record('H ABSENT assertion after known commit', recovery, { outcome: 'UNKNOWN' }, 1, 'SUPPORTED BUT BOUNDED: ABSENT never authorizes local redispatch');
    assert.equal(call(recovery).outcome, 'CONFIRMED'); record('G restored truth recovery', recovery, call(recovery), 1, 'SUPPORTED BUT BOUNDED');
    const crash = fixture('crash'); call(crash, 'crash'); assert.equal(call(crash).outcome, 'CONFIRMED');
    record('process death after controlled provider commit', crash, call(crash), 1, 'SUPPORTED BUT BOUNDED');
    console.log(JSON.stringify({ node: process.version, os: process.platform, evidence }, null, 2));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

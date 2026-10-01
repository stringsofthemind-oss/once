import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectLocal } from '../dist/index.js';
const [major, minor] = process.versions.node.split('.').map(Number);
const localReady = major > 24 || (major === 24 && minor >= 15);

test('unsupported local runtime rejects before dispatch or authority creation', {
  skip: localReady ? 'Unsupported-runtime contract runs on Node 18/20' : false,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'once-unsupported-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let effects = 0;
  const run = protectLocal(async () => { effects++; return { receipt: 'unsafe' }; }, {
    statePath: join(dir, 'state.sqlite'), id: () => 'persisted-intent', payload: () => ({ amount: 100 }),
  });
  await assert.rejects(run(), { code: 'UNSUPPORTED_RUNTIME' });
  assert.equal(effects, 0);
  assert.deepEqual(readdirSync(dir), []);
});

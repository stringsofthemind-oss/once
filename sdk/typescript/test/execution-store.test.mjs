import assert from 'node:assert/strict';
import test from 'node:test';
import { protectLocal, createPostgresExecutionAuthority } from '../dist/index.js';

for (const drift of ['identity', 'effect']) {
  test(`kernel rejects ${drift} drift during asynchronous authority admission`, async () => {
    let id = 'intent-1', amount = 1, effects = 0, unknown = 0;
    const authority = { async open() { return {
      async reserve() { return { dispatch: true }; },
      async assertDispatch() { await Promise.resolve(); if (drift === 'identity') id = 'intent-2'; else amount = 2; },
      async markUnknown() { unknown++; },
      async confirm() { throw new Error('must not confirm'); },
      close() {},
    }; } };
    const run = protectLocal(async () => { effects++; }, { id: () => id, payload: () => ({ amount }), authority });
    await assert.rejects(run(), { code: 'PAYLOAD_DRIFT' });
    assert.equal(effects, 0); assert.equal(unknown, 1);
  });
}

test('authority selection is captured and never silently switches to local state', async () => {
  let opens = 0, effects = 0;
  const options = { id: () => 'intent', payload: () => ({}), authority: { async open() { opens++; throw new Error('shared unavailable'); } } };
  const run = protectLocal(async () => { effects++; }, options);
  options.authority = undefined;
  await assert.rejects(run(), /shared unavailable/);
  assert.equal(opens, 1); assert.equal(effects, 0);
});

test('missing witness and invalid admission cannot construct shared authority', () => {
  for (const expectedEpoch of [undefined, 1, '', '-1', '01']) {
    assert.throws(() => createPostgresExecutionAuthority({
      pool: { connect() {} }, witness: { compareAndAdvance() {} }, authorityId: 'domain', expectedGeneration: 'generation', expectedEpoch,
    }), { code: 'INVALID_CONFIGURATION' });
  }
  assert.throws(() => createPostgresExecutionAuthority({ pool: { connect() {} }, authorityId: 'domain', expectedGeneration: 'generation', expectedEpoch: '1' }), { code: 'INVALID_CONFIGURATION' });
});

import { inspect } from 'node:util';
test('callback errors never expose credential-bearing causes', async () => {
  const token = 'synthetic-secret-do-not-expose';
  let saved;
  const authority = { async open() { return {
    async reserve(id, fingerprint) { return saved ? { dispatch: false, row: saved } : { dispatch: true }; },
    async assertDispatch() {},
    async markUnknown(id, fingerprint) { saved = { id, fingerprint, state: 'UNKNOWN' }; },
    async confirm() { throw new Error('unexpected'); }, close() {},
  }; } };
  const failure = new Error(`Bearer ${token}`);
  failure.request = { headers: { authorization: token } };
  const run = protectLocal(async () => { throw failure; }, {
    id: () => 'redaction', payload: () => ({ amount: 1 }), authority,
    reconcile: async () => { throw failure; },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(run(), error => {
      assert.equal(inspect(error, { depth: 20 }).includes(token), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

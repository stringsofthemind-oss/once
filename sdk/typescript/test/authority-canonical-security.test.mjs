import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectToolCall } from '../dist/index.js';
import { canonicalizeConnectPayload, fingerprintConnectPayload } from '../dist/connect/binding.js';

test('hostile own JSON keys retain distinct canonical bytes, including nested arrays and integer keys', () => {
  const a = JSON.parse('{"amount":1,"__proto__":{"target":"A"},"nested":[{"2":"b","10":"a","constructor":{"prototype":{"target":"A"}}}]}');
  const b = JSON.parse('{"amount":1,"__proto__":{"target":"B"},"nested":[{"2":"b","10":"a","constructor":{"prototype":{"target":"A"}}}]}');
  assert.equal(canonicalizeConnectPayload(a), '{"__proto__":{"target":"A"},"amount":1,"nested":[{"10":"a","2":"b","constructor":{"prototype":{"target":"A"}}}]}');
  assert.notEqual(canonicalizeConnectPayload(a), canonicalizeConnectPayload(b));
  assert.notEqual(fingerprintConnectPayload(a), fingerprintConnectPayload(b));
  assert.equal(Object.getPrototypeOf(a), Object.prototype);
  assert.equal(Object.prototype.target, undefined);
});

for (const path of ['root', 'nested object', 'array element']) {
  test(`durable replay preserves ${path} __proto__ effect and receipt; changed target conflicts`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'once-canonical-security-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const statePath = join(dir, 'state.sqlite'), journal = join(dir, 'provider.jsonl');
    const args = target => {
      const value = JSON.parse(`{"2":"b","10":"a","__proto__":{"target":"${target}"}}`);
      return path === 'root' ? value : path === 'nested object' ? { nested: value } : { nested: [value] };
    };
    const run = target => protectToolCall({
      operationId: 'fixed-intent', effect: { tool: 'fixture.account-A.effect', args: args(target) }, statePath,
      execute: async effect => {
        appendFileSync(journal, JSON.stringify(effect.args) + '\n', { flush: true });
        const value = path === 'root' ? effect.args : path === 'nested object' ? effect.args.nested : effect.args.nested[0];
        assert(Object.isFrozen(value));
        assert(Object.hasOwn(value, '__proto__'));
        assert.equal(Object.getPrototypeOf(value), Object.prototype);
        return effect.args;
      },
    });
    const first = await run('A');
    assert.deepEqual(first, args('A'));
    assert.deepEqual(await run('A'), first);
    await assert.rejects(run('B'), { code: 'CONFLICT' });
    assert.deepEqual(readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse), [args('A')]);
    assert.equal(Object.prototype.target, undefined);
  });
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { wrapTool } from '../dist/index.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'once-wrap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const writes = [];
  const input = { intent: 'intent-1', body: 'hello', tenant: 'A', traceId: 'attempt-1' };
  const options = {
    statePath: path.join(dir, 'state.sqlite'),
    operationId: x => x.intent,
    effect: x => ({ tool: 'provider.account-A.send', args: { body: x.body, tenant: x.tenant } }),
  };
  const callback = async args => {
    assert.ok(Object.isFrozen(args));
    writes.push(args);
    return { id: writes.length, ...args };
  };
  return { input, options, callback, writes, run: wrapTool(callback, options) };
}

test('callback executes declared args; retry and metadata replay; payload, tool and tenant conflict', async t => {
  const f = fixture(t);
  const first = await f.run(f.input);
  assert.deepEqual(f.writes, [{ body: 'hello', tenant: 'A' }]);
  assert.deepEqual(await f.run({ ...f.input, traceId: 'attempt-2', attempt: 9 }), first);
  for (const change of [{ body: 'changed' }, { tenant: 'B' }]) {
    await assert.rejects(f.run({ ...f.input, ...change }), { code: 'CONFLICT' });
  }
  const other = wrapTool(f.callback, { ...f.options, effect: x => ({ tool: 'provider.account-B.send', args: { body: x.body, tenant: x.tenant } }) });
  await assert.rejects(other(f.input), { code: 'CONFLICT' });
  assert.equal(f.writes.length, 1);
});

test('fresh process replays the wrapper receipt from the same authority', async t => {
  const f = fixture(t);
  const first = await f.run(f.input);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { wrapTool } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    const run = wrapTool(async () => { throw Error('redispatch'); }, {
      statePath: process.argv[1], operationId: x => x.intent,
      effect: x => ({ tool: 'provider.account-A.send', args: { body: x.body, tenant: x.tenant } })
    });
    console.log(JSON.stringify(await run(JSON.parse(process.argv[2]))));
  `, f.options.statePath, JSON.stringify(f.input)], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), first);
  assert.equal(f.writes.length, 1);
});

test('hard process exit after callback effect blocks fresh-process redispatch', async t => {
  const f = fixture(t);
  const effectsPath = path.join(path.dirname(f.options.statePath), 'provider-count.txt');
  const shared = `
    import { wrapTool } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    import { writeFileSync } from 'node:fs';
    const options = {
      statePath: process.argv[1], leaseMs: 1, operationId: x => x.intent,
      effect: x => ({ tool: 'crash.account-A.send', args: { body: x.body } })
    };
  `;
  const crash = spawnSync(process.execPath, ['--input-type=module', '-e', shared + `
    await wrapTool(async () => { writeFileSync(process.argv[2], '1'); process.exit(71); }, options)({ intent: 'crash', body: 'test' });
  `, f.options.statePath, effectsPath], { encoding: 'utf8' });
  assert.equal(crash.status, 71, crash.stderr);
  const retry = spawnSync(process.execPath, ['--input-type=module', '-e', shared + `
    try {
      await wrapTool(async () => { writeFileSync(process.argv[2], '2'); return {}; }, options)({ intent: 'crash', body: 'test' });
      process.exit(1);
    } catch(e) { if (e.code !== 'UNKNOWN') throw e; console.log(e.code); }
  `, f.options.statePath, effectsPath], { encoding: 'utf8' });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.stdout.trim(), 'UNKNOWN');
  assert.equal(readFileSync(effectsPath, 'utf8'), '1');
});

test('lost acknowledgement blocks retries and exact positive truth becomes durable replay', async t => {
  const f = fixture(t);
  const lost = wrapTool(async args => { await f.callback(args); throw Error('lost ack'); }, f.options);
  await assert.rejects(lost(f.input), { code: 'UNKNOWN' });
  await assert.rejects(f.run(f.input), { code: 'UNKNOWN' });
  let lookups = 0;
  const recovered = wrapTool(f.callback, { ...f.options, reconcile: ({ operationId, effect }) => {
    lookups++;
    assert.equal(operationId, f.input.intent);
    assert.deepEqual(f.writes[0], effect.args);
    assert.ok(Object.isFrozen(effect.args));
    return { status: 'CONFIRMED', result: { id: 1, ...f.writes[0] } };
  } });
  const receipt = await recovered(f.input);
  assert.deepEqual(await f.run(f.input), receipt);
  assert.equal(lookups, 1);
  assert.equal(f.writes.length, 1);
});

for (const observation of ['NOT_FOUND', 'UNKNOWN', 'throws', 'missing-result', 'contradictory', 'non-json']) {
  test(`reconciliation ${observation} stays blocked`, async t => {
    const f = fixture(t);
    await assert.rejects(wrapTool(async args => { await f.callback(args); throw Error('lost'); }, f.options)(f.input), { code: 'UNKNOWN' });
    const reconcile = () => {
      if (observation === 'throws') throw Error('lookup');
      if (observation === 'missing-result') return { status: 'CONFIRMED' };
      if (observation === 'contradictory') return { status: 'CONFIRMED', result: {}, error: 'lookup failed' };
      if (observation === 'non-json') return { status: 'CONFIRMED', result: new Map() };
      return { status: observation };
    };
    await assert.rejects(wrapTool(f.callback, { ...f.options, reconcile })(f.input), { code: 'UNKNOWN' });
    await assert.rejects(f.run(f.input), { code: 'UNKNOWN' });
    assert.equal(f.writes.length, 1);
  });
}

test('throw before known outcome is UNKNOWN even with zero observed writes', async t => {
  const f = fixture(t);
  await assert.rejects(wrapTool(async () => { throw Error('before'); }, f.options)(f.input), { code: 'UNKNOWN' });
  await assert.rejects(f.run(f.input), { code: 'UNKNOWN' });
  assert.equal(f.writes.length, 0);
});

test('concurrent calls have one claimant', async t => {
  const f = fixture(t);
  let enter, release;
  const ready = new Promise(r => { enter = r; });
  const gate = new Promise(r => { release = r; });
  const run = wrapTool(async args => { enter(); await gate; return f.callback(args); }, f.options);
  const first = run(f.input);
  await ready;
  try { await assert.rejects(run(f.input), { code: 'IN_FLIGHT' }); }
  finally { release(); }
  await first;
  assert.equal(f.writes.length, 1);
});

test('caller input, effect declaration and configuration mutation cannot change in-flight effect', async t => {
  const f = fixture(t);
  const declaration = { tool: 'fixed.A.send', args: { body: 'snapshot' } };
  const options = { ...f.options, effect: () => declaration };
  const run = wrapTool(async args => {
    assert.throws(() => { args.body = 'changed'; }, TypeError);
    return f.callback(args);
  }, options);
  const pending = run(f.input);
  declaration.args.body = 'later';
  declaration.tool = 'fixed.B.send';
  f.input.body = 'later';
  options.operationId = () => 'other';
  assert.equal((await pending).body, 'snapshot');
  assert.equal(f.writes.length, 1);
});

test('selectors receive strict frozen input and must supply identity and valid effect', async t => {
  const f = fixture(t);
  assert.throws(() => wrapTool(f.callback, {}), { code: 'INVALID_CONFIGURATION' });
  for (const operationId of [() => '', () => undefined, () => Promise.resolve('id')]) {
    await assert.rejects(wrapTool(f.callback, { ...f.options, operationId })(f.input), { code: 'IDENTITY_REQUIRED' });
  }
  for (const effect of [() => undefined, () => ({}), () => ({ tool: 'x' }), () => ({ tool: '', args: {} }), () => Promise.resolve({ tool: 'x', args: {} })]) {
    await assert.rejects(wrapTool(f.callback, { ...f.options, effect })(f.input));
  }
  const mutation = wrapTool(f.callback, { ...f.options, operationId: x => { x.body = 'changed'; return x.intent; } });
  await assert.rejects(mutation(f.input), TypeError);
  await assert.rejects(f.run({ ...f.input, opaque: new Date() }), { code: 'UNSUPPORTED_VALUE' });
  assert.equal(f.writes.length, 0);
});

test('dynamic receiver is preserved; authority remains developer-owned', async t => {
  const f = fixture(t);
  const host = { fixed: 'A', send: wrapTool(async function(args) { return { authority: this.fixed, ...args }; }, f.options) };
  assert.equal((await host.send(f.input)).authority, 'A');
});

test('opaque callback internal retries are outside the guarantee', async t => {
  const f = fixture(t);
  const opaque = wrapTool(async args => { await f.callback(args); return f.callback(args); }, f.options);
  const first = await opaque(f.input);
  assert.deepEqual(await opaque(f.input), first);
  assert.equal(f.writes.length, 2, 'one Once dispatch can contain multiple opaque provider writes');
});

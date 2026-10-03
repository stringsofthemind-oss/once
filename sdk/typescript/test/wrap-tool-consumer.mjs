import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wrapTool } from '@once-agent/sdk';
const require = createRequire(import.meta.url);
const dir = mkdtempSync(path.join(os.tmpdir(), 'once-consumer-'));
try {
  for (const [mode, api] of [['ESM', wrapTool], ['CJS', require('@once-agent/sdk').wrapTool]]) {
    let writes = 0;
    const opts = { statePath: path.join(dir, mode + '.sqlite'), operationId: x => x.intent, effect: x => ({ tool: 'consumer.account-A.send', args: { body: x.body } }) };
    const run = api(async args => ({ id: ++writes, ...args }), opts);
    const input = { intent: 'first', body: 'synthetic' };
    const first = await run(input);
    assert.deepEqual(await run(input), first);
    await assert.rejects(run({ ...input, body: 'changed' }), { code: 'CONFLICT' });
    let committed;
    const lost = api(async args => { committed = { id: ++writes, ...args }; throw Error('lost'); }, opts);
    const lostInput = { intent: 'lost', body: 'lost synthetic' };
    await assert.rejects(lost(lostInput), { code: 'UNKNOWN' });
    await assert.rejects(run(lostInput), { code: 'UNKNOWN' });
    const recovered = api(async () => { throw Error('redispatch'); }, { ...opts, reconcile: () => ({ status: 'CONFIRMED', result: committed }) });
    assert.deepEqual(await recovered(lostInput), committed);
    assert.deepEqual(await run(lostInput), committed);
    assert.equal(writes, 2);
    console.log(`${mode}: 7 checks passed; writes=2`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

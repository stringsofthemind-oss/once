import assert from 'node:assert/strict';
import nodeTest from 'node:test';
const [major, minor] = process.versions.node.split('.').map(Number);
const localReady = major > 24 || (major === 24 && minor >= 15);
const test = (name, fn) => nodeTest(name, { skip: !localReady }, fn);
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGithubIssueTool } from '../../examples/github-issue-recovery.mjs';

// Controlled provider responses for regression coverage, not real-provider evidence.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'once-github-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const issues = []; const requests = [];
  let lookup = 'normal'; let release; let entered;
  const start = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const options = { token: 'test-only', repository: 'owner/repo', actor: 'owner', statePath: join(dir, 'state.sqlite'),
    async fetchImpl(url, init) {
      requests.push({ url, method: init.method });
      assert.equal(init.redirect, 'error');
      if (init.method === 'POST') {
        const issue = { ...JSON.parse(init.body), number: issues.length + 1, user: { login: 'owner' },
          html_url: `https://github.com/owner/repo/issues/${issues.length + 1}` };
        issues.push(issue); entered();
        if (lookup === 'hold') await gate;
        return { status: 201, json: async () => issue };
      }
      if (lookup === 'timeout') throw new Error('provider timeout');
      if (lookup === 'rate-limit') return { status: 429 };
      let result = issues;
      if (!url.includes('?')) result = lookup === 'edited' ? { ...issues[0], title: 'edited' } : issues[0];
      else if (lookup === 'missing') result = [];
      else if (lookup === 'duplicate') result = [issues[0], { ...issues[0], number: 2, html_url: 'https://github.com/owner/repo/issues/2' }];
      else if (lookup === 'wrong-author') result = [{ ...issues[0], user: { login: 'other' } }];
      else if (lookup === 'full') result = Array.from({ length: 100 }, (_, n) => ({ number: 1000 + n }));
      return { status: 200, json: async () => result };
    } };
  return { issues, requests, tool: extra => createGithubIssueTool({ ...options, ...extra }), set: value => { lookup = value; }, start, release };
}
const input = { intent: 'persisted-business-action-A', title: 'Example', body: 'Body' };

test('lost acknowledgement recovers by marker without retaining the POST receipt', async t => {
  const f = fixture(t);
  await assert.rejects(f.tool({ simulateLostAck: true }).execute(input), { code: 'UNKNOWN' });
  f.set('timeout');
  await assert.rejects(f.tool().execute(input), { code: 'UNKNOWN' });
  f.set('normal');
  const recovered = await f.tool().execute(input);
  assert.equal(recovered.issue_number, 1);
  assert.deepEqual(await f.tool().execute(input), recovered);
  assert.equal(f.issues.length, 1);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  assert.ok(f.requests.some(r => r.url.endsWith('/issues/1')));
});

for (const mode of ['missing', 'duplicate', 'wrong-author', 'edited', 'full', 'rate-limit']) {
  test(`recovery fails closed on ${mode} provider evidence`, async t => {
    const f = fixture(t);
    await assert.rejects(f.tool({ simulateLostAck: true }).execute(input), { code: 'UNKNOWN' });
    f.set(mode);
    await assert.rejects(f.tool({ maxPages: 2 }).execute(input), { code: 'UNKNOWN' });
    assert.equal(f.issues.length, 1);
    assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  });
}

test('changed effect conflicts; distinct business identity remains executable', async t => {
  const f = fixture(t); const tool = f.tool();
  const first = await tool.execute(input);
  await assert.rejects(tool.execute({ ...input, title: 'Changed' }), { code: 'CONFLICT' });
  const second = await tool.execute({ ...input, intent: 'persisted-business-action-B' });
  assert.notEqual(first.issue_number, second.issue_number);
  assert.equal(f.issues.length, 2);
});

test('concurrent caller is rejected until the winning result is replayable', async t => {
  const f = fixture(t); f.set('hold'); const tool = f.tool();
  const first = tool.execute(input);
  await f.start;
  try { await assert.rejects(tool.execute(input), { code: 'IN_FLIGHT' }); }
  finally { f.release(); }
  const result = await first;
  assert.deepEqual(await tool.execute(input), result);
  assert.equal(f.issues.length, 1);
});

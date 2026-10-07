import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import { createLocalProtectionSession } from '@once-agent/sdk/connect';
import { GitHubIssueClient, registerProtectedGitHubIssue } from '@once-agent/mcp/github-issue';
import { startGitHubFixture } from './fixtures/github-provider.mjs';

test('GitHub adapter: authenticated LOCAL REST fixture, not real GitHub', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'once-github-'));
  const statePath = path.join(dir, 'operations.sqlite');
  const provision = createLocalProtectionSession(statePath); await provision.databaseForCall(); provision.close();
  const fixture = await startGitHubFixture(path.join(dir, 'provider-issues.jsonl'));
  const intents = Object.fromEntries(['first','new','concurrent','lost','malformed','restart'].map(x => [x, `op-${x}`]));
  let lose = true;
  let lookup = false;
  const provider = new GitHubIssueClient({ authority: fixture.authority, token: 'fixture-only-token', request: fixture.request,
    afterCommit: async () => { if (lose && fixture.records().at(-1).title === 'lost') { lose = false; throw Error('lost acknowledgement'); } },
    lookupAllowed: () => lookup,
  });
  const openMemory = async (overrides = {}) => {
    const server = new McpServer({ name: 'test', version: '1' });
    const registration = await registerProtectedGitHubIssue(server, { statePath, intents, provider, authorize: async () => {}, ...overrides });
    const client = new Client({ name: 'agent', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    return { client, close: async () => { await client.close(); await server.close(); registration.close(); } };
  };
  const openProcess = async () => {
    const client = new Client({ name: 'new-agent', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/github-host.mjs', import.meta.url))], env: { ...process.env, ONCE_GITHUB_FIXTURE: JSON.stringify({ statePath, intents, authority: fixture.authority, fixtureUrl: fixture.url }) }, stderr: 'pipe' });
    try { await client.connect(transport); } catch (error) { await client.close(); throw error; }
    return { client, close: () => client.close() };
  };
  const opened = [];
  t.after(async () => { for (const host of opened) await host.close(); await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  const host = await openMemory(); opened.push(host);
  const invoke = async (h, args, tool = 'once_create_github_issue') => {
    const response = await h.client.callTool({ name: tool, arguments: args });
    if (!response.structuredContent) return { status: 'SCHEMA_REJECTED' };
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    return response.structuredContent;
  };
  const input = (taskRef, title = 'Export fails', body = 'No download appears.') => ({ taskRef, title, body });
  const proof = [];
  const check = (label, fn) => t.test(label, async () => { await fn(); proof.push({ scenario: label, independentlyCountedIssues: fixture.records().length, posts: fixture.posts, issueIds: fixture.records().map(x => x.id) }); });
  const noWrite = async fn => { const before = fixture.posts; await fn(); assert.equal(fixture.posts, before); };
  let confirmed;
  await check('strict two-tool catalog and fixed host task references', async () => {
    const tools = (await host.client.listTools()).tools;
    assert.deepEqual(tools.map(x => x.name).sort(), ['once_create_github_issue', 'once_github_issue_context']);
    const schema = tools.find(x => x.name === 'once_create_github_issue').inputSchema;
    assert.deepEqual(Object.keys(schema.properties).sort(), ['body','taskRef','title']); assert.equal(schema.additionalProperties, false);
    const context = await invoke(host, {}, 'once_github_issue_context'); assert.deepEqual(context.taskRefs, Object.keys(intents));
  });
  await check('first issue creation independently counted', async () => {
    confirmed = await invoke(host, input('first')); assert.equal(confirmed.status, 'CONFIRMED');
    assert.equal(fixture.records().length, 1); assert.equal(confirmed.result.providerReference, String(fixture.records()[0].id));
    assert.match(fixture.records()[0].body, /once-correlation:op-first:/);
  });
  await check('same intent replay and changed title/body conflict', () => noWrite(async () => {
    assert.deepEqual(await invoke(host, input('first')), confirmed);
    assert.equal((await invoke(host, input('first', 'Changed'))).status, 'CONFLICT');
    assert.equal((await invoke(host, input('first', 'Export fails', 'Changed'))).status, 'CONFLICT');
  }));
  await check('same payload with genuinely new provisioned intent creates second issue', async () => {
    assert.equal((await invoke(host, input('new'))).status, 'CONFIRMED'); assert.equal(fixture.records().length, 2);
  });
  await check('concurrent invocation from two actual processes creates one issue', async () => {
    fixture.controls.delay = 100;
    const a = await openProcess(), b = await openProcess(); opened.push(a,b);
    const before = fixture.posts;
    const results = await Promise.all([invoke(a,input('concurrent')),invoke(b,input('concurrent'))]);
    assert.ok(results.some(x => x.status === 'CONFIRMED')); assert.equal(fixture.posts, before + 1);
    assert.equal((await invoke(a,input('concurrent'))).status, 'CONFIRMED');
    fixture.controls.delay = 0; await a.close(); await b.close();
  });
  await check('lost acknowledgement commits one issue and returns UNKNOWN', async () => {
    const before = fixture.posts; assert.equal((await invoke(host,input('lost','lost'))).status, 'UNKNOWN'); assert.equal(fixture.posts, before + 1);
  });
  await check('UNKNOWN retry while lookup disabled adds no issue', () => noWrite(async () => assert.equal((await invoke(host,input('lost','lost'))).status, 'UNKNOWN')));
  lookup = true;
  for (const mode of ['unavailable','zero','duplicate','mismatch','incomplete','stale']) {
    await check(`${mode} reconciliation remains blocked`, () => noWrite(async () => {
      fixture.controls.lookup = mode;
      const outcome = await invoke(host,input('lost','lost'));
      assert.equal(outcome.status,'UNKNOWN'); assert.equal(outcome.retryAllowed,false);
    }));
  }
  fixture.controls.lookup = 'normal';
  let recovered;
  await check('positive read-only reconciliation recovers original issue', () => noWrite(async () => {
    recovered = await invoke(host,input('lost','lost')); assert.equal(recovered.status,'CONFIRMED');
    assert.equal(recovered.result.providerReference,String(fixture.records().find(x=>x.title==='lost').id));
  }));
  await check('recovered replay and changed effect conflict', () => noWrite(async () => {
    assert.deepEqual(await invoke(host,input('lost','lost')),recovered);
    assert.equal((await invoke(host,input('lost','different'))).status,'CONFLICT');
  }));
  await check('malformed creation response remains UNKNOWN until exact provider recovery', async () => {
    fixture.controls.malformed = true;
    assert.equal((await invoke(host,input('malformed'))).status,'UNKNOWN'); fixture.controls.malformed = false;
    await noWrite(async () => assert.equal((await invoke(host,input('malformed'))).status,'CONFIRMED'));
  });
  await check('changed authenticated account/repository blocks even replay', () => noWrite(async () => {
    for (const key of ['userId','repositoryId']) {
      const value = fixture.controls[key]; fixture.controls[key] = 99;
      assert.equal((await invoke(host,input('first'))).status,'UNSUPPORTED_BOUNDARY'); fixture.controls[key] = value;
    }
  }));
  await check('credential-bearing input, raw operation and unprovisioned intent rejected', () => noWrite(async () => {
    for (const args of [{...input('first'),Authorization:'secret'}, {...input('first'),owner:'other'}, {...input('first'),operationId:'escape'}, input('first','Bearer secret'), input('first','github_pat_secret'), input('unregistered')]) assert.notEqual((await invoke(host,args)).status,'CONFIRMED');
    await assert.rejects(invoke(host,input('first'),'github_raw_post'));
  }));
  await check('actual process restart and agent handoff retain result and conflict boundary', () => noWrite(async () => {
    const other = await openProcess(); opened.push(other);
    assert.deepEqual(await invoke(other,input('first')),confirmed);
    assert.deepEqual(await invoke(other,input('lost','lost')),recovered);
    assert.equal((await invoke(other,input('first','Changed'))).status,'CONFLICT'); await other.close();
  }));
  await check('raw provider bypass creates duplicates: fixture does not deduplicate', async () => {
    const issue = fixture.records()[0], before = fixture.posts;
    for (let i=0;i<2;i++) {
      const response = await fixture.request('https://api.github.com/repos/canary/disposable/issues',{method:'POST',headers:{Authorization:'Bearer fixture-only-token'},body:JSON.stringify({title:issue.title,body:issue.body})}); assert.equal(response.status,201);
    }
    assert.equal(fixture.posts,before+2); assert.equal(fixture.records().filter(x=>x.body===issue.body).length,3);
  });
  await check('missing/corrupt/empty existing ledger is never provisioned by registration', async () => {
    for (const [file, content] of [['corrupt','invalid'],['empty','']]) { const target=path.join(dir,file);writeFileSync(target,content); await assert.rejects(openMemory({statePath:target})); }
    await assert.rejects(openMemory({statePath:path.join(dir,'absent')}));
  });
  await check('live schema loss followed by actual process restart never dispatches', () => noWrite(async () => {
    const db = new DatabaseSync(statePath); db.exec('DROP TABLE local_operations'); db.close();
    assert.equal((await invoke(host,input('restart'))).status,'STATE_UNAVAILABLE');
    for (const h of opened) await h.close();
    await assert.rejects(openProcess());
  }));
  if(process.env.ONCE_GITHUB_PROOF_PATH)writeFileSync(process.env.ONCE_GITHUB_PROOF_PATH,JSON.stringify({ evidenceTier:'LOCAL authenticated GitHub REST fixture; NOT GitHub provider proof or installed GPT routing',runtime:process.version,scenarios:proof,providerIssues:fixture.records()},null,2));
});

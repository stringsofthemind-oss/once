import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Annotation, StateGraph, MemorySaver, START, END } from '@langchain/langgraph';

const dir = mkdtempSync(join(tmpdir(), 'once-langgraph-7417-'));
const log = join(dir, 'provider.jsonl');
writeFileSync(log, '');
const rows = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
let hold = false, releaseResponse, committed;
// Intentionally NO idempotency/deduplication: every POST commits a new record.
// Provider owns this append-only log; graph and Once cannot manufacture counts.
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/effects') {
    res.end(JSON.stringify(rows())); return;
  }
  if (req.method !== 'POST' || req.url !== '/effects') { res.writeHead(404).end(); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const args = JSON.parse(body);
  const receipt = { id: rows().length + 1, operationId: args.operationId, amount: args.amount };
  appendFileSync(log, JSON.stringify({ args, receipt }) + '\n');
  if (hold) {
    hold = false;
    const gate = new Promise(resolve => { releaseResponse = resolve; });
    committed?.(); await gate;
  }
  res.end(JSON.stringify(receipt));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const provider = `http://127.0.0.1:${server.address().port}`;
const effect = operationId => ({ tool: 'fixture.account-A.refund', args: {
  provider, account: 'A', operationId, orderId: `order-${operationId}`, amount: 100, currency: 'GBP',
} });
const count = operationId => rows().filter(row => row.args.operationId === operationId).length;
const worker = options => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const timeout = setTimeout(() => { child.kill(); reject(Error('worker exceeded 30s deadline')); }, 30000);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { clearTimeout(timeout); reject(error); });
  child.on('close', status => { clearTimeout(timeout); resolve({ status, ...(stdout.trim() ? JSON.parse(stdout.trim()) : {}), stderr }); });
});
const State = Annotation.Root({ input: Annotation(), output: Annotation() });
const evidence = [];
async function waitForCommit(ready, execution) {
  let timer;
  try {
    await Promise.race([ready,
      execution.then(outcome => { throw Error(`execution ended before provider commit: ${JSON.stringify(outcome)}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('provider commit exceeded 30s deadline')), 30000); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function replayScenario(protectedBoundary) {
  const operationId = protectedBoundary ? 'protected' : 'unprotected';
  const input = { operationId, effect: effect(operationId), statePath: join(dir, `${operationId}.sqlite`) };
  let invocations = 0;
  const graph = new StateGraph(State).addNode('tools', async state => {
    invocations++;
    let outcome;
    if (protectedBoundary) outcome = await worker(state.input);
    else outcome = { result: await (await fetch(`${provider}/effects`, {
      method: 'POST', body: JSON.stringify(state.input.effect.args),
    })).json() };
    return { output: outcome };
  }).addEdge(START, 'tools').addEdge('tools', END).compile({ checkpointer: new MemorySaver(), interruptBefore: ['tools'] });
  const config = { configurable: { thread_id: operationId } };
  await graph.invoke({ input }, config);
  const checkpoint = await graph.getState(config);
  assert.deepEqual(checkpoint.next, ['tools']);
  // Reuse the exact pre-tools checkpoint, while first provider response is held.
  hold = true;
  const ready = new Promise(resolve => { committed = resolve; });
  const first = graph.invoke(null, checkpoint.config);
  await waitForCommit(ready, first);
  let duplicate;
  try { duplicate = await graph.invoke(null, checkpoint.config); }
  finally { releaseResponse(); }
  const completed = await first;
  assert.ok(completed.output.result);
  if (protectedBoundary) {
    assert.equal(duplicate.output.code, 'IN_FLIGHT');
    const fresh = await worker(input);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.deepEqual(fresh.result, completed.output.result);
    const replay = await graph.invoke(null, checkpoint.config);
    assert.deepEqual(replay.output.result, completed.output.result);
  } else assert.ok(duplicate.output.result);
  assert.equal(count(operationId), protectedBoundary ? 1 : 2);
  evidence.push({ scenario: operationId, toolsInvocations: invocations,
    overlapOutcome: duplicate.output.code ?? 'second effect committed', providerPosts: count(operationId),
    checkpointId: checkpoint.config.configurable.checkpoint_id });
}
try {
  await replayScenario(false);
  await replayScenario(true);
  // A lease is not execution authority: replay after expiry must still block
  // while the original provider request has committed but remains unacknowledged.
  const expiredId = 'expired-live';
  const expiredInput = { operationId: expiredId, effect: effect(expiredId), statePath: join(dir, 'expired.sqlite'), leaseMs: 1 };
  hold = true;
  const ready = new Promise(resolve => { committed = resolve; });
  const pending = worker(expiredInput);
  await waitForCommit(ready, pending);
  const expiredDuplicate = await worker(expiredInput);
  assert.equal(expiredDuplicate.code, 'UNKNOWN');
  releaseResponse();
  const original = await pending;
  assert.equal(original.code, 'EXECUTION_RIGHT_LOST');
  const settled = await worker({ ...expiredInput, truth: 'authoritative' });
  assert.equal(settled.status, 0, settled.stderr);
  assert.equal(count(expiredId), 1);
  evidence.push({ scenario: expiredId, leaseMs: 1, overlapOutcome: expiredDuplicate.code,
    originalOutcome: original.code ?? 'CONFIRMED', reconciled: settled.result, providerPosts: count(expiredId) });
  const operationId = 'lost-ack';
  const input = { operationId, effect: effect(operationId), statePath: join(dir, 'lost.sqlite'), leaseMs: 1 };
  assert.equal((await worker({ ...input, crash: true })).status, 77);
  const outcomes = [];
  for (const truth of [undefined, 'unavailable', 'missing', 'malformed']) {
    const blocked = await worker({ ...input, truth });
    assert.equal(blocked.code, 'UNKNOWN', JSON.stringify(blocked));
    assert.equal(count(operationId), 1);
    outcomes.push({ truth: truth ?? 'none', code: blocked.code });
  }
  const recovered = await worker({ ...input, truth: 'authoritative' });
  assert.equal(recovered.status, 0, recovered.stderr);
  const fresh = await worker(input);
  assert.deepEqual(fresh.result, recovered.result);
  const conflict = await worker({ ...input, effect: { ...input.effect, args: { ...input.effect.args, amount: 200 } } });
  assert.equal(conflict.code, 'CONFLICT');
  assert.equal(count(operationId), 1);
  evidence.push({ scenario: operationId, crashExit: 77, blocked: outcomes,
    reconciled: recovered.result, freshProcessReplay: fresh.result, changedEffect: conflict.code, providerPosts: count(operationId) });
  const report = { scope: 'LOCAL SIMULATION; real LangGraph JS checkpoint replay; NOT LangGraph Cloud reproduction',
    environment: { node: process.version, platform: platform(), release: release(), once: '0.1.25', langgraph: '1.4.19' },
    evidence, providerRecords: rows(), artifacts: dir };
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('PASS: independently counted provider effects match all assertions.');
} finally {
  releaseResponse?.();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

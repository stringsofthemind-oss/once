// Evidence checker intentionally has no Once/MCP imports.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Supply the run directory printed by the evidence runner');
const json = relative => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const lines = relative => readFileSync(path.join(root, relative), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const results = json('results.json');
assert.equal(json('execution.json').exitCode, 0, 'test process must have exited successfully');
assert.equal(results.success, true); assert.equal(results.tests.length, 8); assert.equal(results.failed, 0);
assert.equal(results.eventsSha256, createHash('sha256').update(readFileSync(path.join(root, 'events.jsonl'))).digest('hex'));
const events = lines('events.jsonl');
assert.deepEqual(events.map(x => x.sequence), events.map((_, i) => i + 1));
const counts = { T01: 2, T02: 1, T03: 1, T04: 1, T05: 1, T06: 2, T07: 2, T08: 1 };
for (const [test, expected] of Object.entries(counts)) {
  assert.equal(lines(`${test}/provider.jsonl`).length, expected, `${test} provider journal`);
  assert.equal(json(`${test}/provider-counters.json`).posts, expected, `${test} raw write requests`);
  assert.equal(events.filter(x => x.test === test && x.event === 'provider-commit-fsynced').length, expected);
}
const canonical = events.filter(x => x.test === 'T02');
const index = name => canonical.findIndex(x => x.event === name);
for (const event of ['provider-commit-fsynced', 'provider-acknowledgement-dropped', 'worker-observed-ack-loss-before-once-return', 'worker-killed-call-closed', 'abandoned-claim', 'final-ledger']) assert.ok(index(event) >= 0, `missing event ${event}`);
assert.ok(index('provider-commit-fsynced') < index('provider-acknowledgement-dropped'));
assert.ok(index('provider-acknowledgement-dropped') < index('worker-observed-ack-loss-before-once-return'));
assert.ok(index('worker-observed-ack-loss-before-once-return') < index('worker-killed-call-closed'));
assert.ok(index('worker-killed-call-closed') < index('abandoned-claim'));
const requests = canonical.filter(x => x.event === 'mcp-request');
assert.equal(new Set(requests.map(x => x.operationId)).size, 1);
assert.ok(new Set(requests.map(x => x.sessionId)).size >= 4);
assert.ok(new Set(requests.map(x => x.attemptId)).size >= 4);
assert.notEqual(requests[0].requestId, requests[1].requestId);
const outcomes = canonical.filter(x => x.event === 'mcp-outcome').map(x => x.outcome);
assert.equal(outcomes[0].code, 'IN_FLIGHT');
assert.ok(outcomes.filter(x => x.code === 'UNKNOWN').length >= 4);
for (const x of outcomes.filter(x => x.code)) assert.equal(x.retryAllowed, false);
const receipt = lines('T02/provider.jsonl')[0];
const confirmed = outcomes.filter(x => x.status === 'CONFIRMED');
assert.equal(confirmed.length, 2);
for (const x of confirmed) assert.deepEqual(x.result, receipt);
const row = canonical.find(x => x.event === 'final-ledger').rows[0];
assert.equal(row.state, 'CONFIRMED'); assert.deepEqual(JSON.parse(row.result_json).value, receipt);
const checked = { success: true, checker: 'no Once or MCP imports', providerEffectCounts: counts, canonicalOperationId: receipt.operationId,
  canonicalSessions: new Set(requests.map(x => x.sessionId)).size, canonicalProviderEffects: 1,
  limitsObserved: ['new operation ID can create second effect', 'valid empty replacement ledger across restart can create second effect'] };
writeFileSync(path.join(root, 'independent-check.json'), JSON.stringify(checked, null, 2));
console.log(JSON.stringify(checked, null, 2));

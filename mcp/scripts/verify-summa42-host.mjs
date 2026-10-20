// Independent durable-state check: no Once, MCP or PostgreSQL client imports.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const root = path.resolve(process.argv[2] ?? ''); assert.ok(process.argv[2], 'Supply an actual Summa42 service run directory');
const json = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const lines = file => readFileSync(path.join(root, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const result = json('results.json'), events = lines('events.jsonl'), provider = lines('provider.jsonl');
assert.equal(result.success, true); assert.equal(result.gateAppliedBeforeReplacementAttempt, true);
assert.equal(result.summa42Revision, 'efc6794ea79a4be5b2f60e376833a1d03cba053c');
assert.equal(provider.length, 1); assert.equal(result.providerCounters.posts, 1);
assert.equal(provider[0].operationId, result.binding.operationId);
const blocked = events.filter(x => x.event === 'actual-summa42-stage' && x.result.hostGate === 'BLOCKED_UNRESOLVED');
assert.equal(blocked.length, 3); assert.equal(new Set(blocked.map(x => x.result.pid)).size, 3);
for (const { result: state } of blocked) {
  assert.equal(state.state, 'OUTCOME_UNKNOWN'); assert.equal(state.reservation, 'UNRESOLVED');
  assert.equal(state.attemptId, result.source.attemptId); assert.equal(state.operationId, result.source.operationId);
}
const killed = events.find(x => x.event === 'actual-summa42-worker-killed');
assert.equal(killed.ledger[0].state, 'DISPATCHED');
const confirmed = events.filter(x => x.event === 'actual-summa42-stage' && x.result.state === 'CONFIRMED_EFFECT');
assert.equal(confirmed.length, 2);
const db = new DatabaseSync(path.join(root, 'actual-summa42/summa42.sqlite'), { readOnly: true });
try {
  const attempts = db.prepare('SELECT attempt_id FROM attempts').all().map(x => x.attempt_id);
  assert.deepEqual(new Set(attempts), new Set([result.source.attemptId, ...confirmed.map(x => x.result.attemptId)]));
  const op = db.prepare('SELECT * FROM external_operations').all(); assert.equal(op.length, 1);
  assert.equal(op[0].state, 'CONFIRMED_EFFECT'); assert.equal(op[0].provider_reference, provider[0].providerReference);
  assert.equal(op[0].effect_slot_id, result.source.effectSlotId);
  assert.equal(db.prepare('SELECT state FROM resource_reservations').get().state, 'SETTLED');
} finally { db.close(); }
const checked = { success: true, checkerImports: 'Node built-ins only', actualServiceProcesses: new Set(events.filter(x => x.event === 'actual-summa42-stage').map(x => x.result.pid)).size + 1,
  unknownWorkersBlockedBeforeNewAttempt: 3, providerPosts: 1, providerEffects: 1, finalAttempts: 3, globalBoxPlannerConformance: 'unverified' };
writeFileSync(path.join(root, 'independent-check.json'), JSON.stringify(checked, null, 2)); console.log(JSON.stringify(checked, null, 2));

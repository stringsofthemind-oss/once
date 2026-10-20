// Independent evidence invariants: intentionally no Once, MCP or SQL imports.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [mode, directory] = process.argv.slice(2);
assert.ok(['baseline', 'protected'].includes(mode) && directory, 'Use: node verify-hardening.mjs baseline|protected RUN_DIRECTORY');
const root = path.resolve(directory);
const lines = file => readFileSync(path.join(root, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const json = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
if (mode === 'baseline') {
  const counts = { T06: lines('T06/provider.jsonl').length, T07: lines('T07/provider.jsonl').length };
  writeFileSync(path.join(root, 'protection-invariants.json'), JSON.stringify({ phase: 'RED', requiredMaximum: 1, T06: { effects: counts.T06, protected: counts.T06 <= 1 }, T07: { effects: counts.T07, protected: counts.T07 <= 1 } }, null, 2));
  console.log(JSON.stringify({ phase: 'RED', requiredMaximumEffectsPerIntent: 1, observed: counts }));
  assert.equal(counts.T06, 1, 'T06 protection invariant RED: planner identity substitution caused another effect');
  assert.equal(counts.T07, 1, 'T07 protection invariant RED: replacement ledger caused another effect');
} else {
  const results = json('results.json'); assert.equal(results.success, true); assert.equal(json('execution.json').exitCode, 0);
  const events = lines('events.jsonl'), journal = lines('provider.jsonl');
  assert.equal(json('provider-counters.json').posts, journal.length);
  const counts = new Map(); for (const receipt of journal) counts.set(receipt.operationId, (counts.get(receipt.operationId) ?? 0) + 1);
  for (const count of counts.values()) assert.equal(count, 1, 'no admitted operation may produce a second effect');
  const ids = {};
  for (const scenario of ['H01', 'H02', 'H03', 'H04']) {
    const start = events.findIndex(x => x.event === 'scenario-start' && x.id === scenario);
    const finish = events.findIndex((x, i) => i > start && x.event === 'scenario-end' && x.id === scenario);
    const trace = events.slice(start, finish + 1);
    const binding = trace.find(x => x.event === 'host-intent-admitted').binding;
    ids[scenario] = binding.operationId;
    assert.equal(counts.get(binding.operationId) ?? 0, scenario === 'H04' ? 0 : 1);
    if (scenario === 'H01') {
      assert.ok(trace.some(x => x.result?.code === 'IDENTITY_CONFLICT'));
      const newIntent = trace.find(x => x.event === 'separately-authorized-new-intent').binding;
      assert.notEqual(newIntent.operationId, binding.operationId); assert.notEqual(newIntent.intentKey, binding.intentKey);
      assert.equal(counts.get(newIntent.operationId), 1);
    }
    if (scenario === 'H02') assert.ok(trace.some(x => x.result?.code === 'CONTINUITY_LOST'));
    if (scenario === 'H03') {
      const commit = trace.findIndex(x => x.event === 'provider-commit-fsynced');
      const dropped = trace.findIndex(x => x.event === 'provider-ack-dropped');
      const killed = trace.findIndex(x => x.event === 'worker-killed-after-provider-commit');
      assert.ok(commit >= 0 && dropped > commit && killed > dropped);
      assert.ok(trace.filter(x => x.result?.code === 'UNKNOWN').length >= 3);
      assert.equal(trace.filter(x => x.result?.status === 'CONFIRMED').length, 2);
      assert.ok(new Set(trace.filter(x => x.event === 'mcp-request').map(x => x.sessionId)).size >= 5);
    }
    if (scenario === 'H04') assert.ok(trace.some(x => x.result?.code === 'UNKNOWN'));
  }
  const report = { success: true, phase: 'GREEN', checkerImports: 'Node built-ins only', namedScenarios: results.passed,
    canonicalT06Effects: counts.get(ids.H01), canonicalT07Effects: counts.get(ids.H02),
    commitCrashEffects: counts.get(ids.H03), preEffectCrashEffects: counts.get(ids.H04) ?? 0,
    providerEffects: journal.length, maxEffectsPerAdmittedOperation: Math.max(...counts.values()) };
  const snapshot = json('authority-snapshot.json');
  const preEffect = snapshot.operations.find(x => x.id === ids.H04);
  assert.equal(preEffect.state, 'UNKNOWN'); assert.equal(preEffect.result_json, null);
  for (const authority of snapshot.authorities) {
    const checkpoint = snapshot.checkpoints.find(x => x.authority_id === authority.authority_id);
    assert.equal(checkpoint.generation, authority.generation);
    assert.equal(String(checkpoint.epoch), String(authority.epoch));
    assert.equal(String(checkpoint.revision), String(authority.revision));
    assert.equal(checkpoint.state_digest, authority.state_digest);
  }
  writeFileSync(path.join(root, 'independent-check.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}

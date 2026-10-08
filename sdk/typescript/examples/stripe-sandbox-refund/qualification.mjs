import assert from 'node:assert/strict';
export function refundEvidence(refunds) {
  return refunds.map(r => ({ id: r.id, object: r.object, paymentIntent: r.payment_intent,
    amount: r.amount, currency: r.currency, status: r.status,
    operationId: r.metadata?.once_operation_id, effectHash: r.metadata?.once_effect_hash }));
}
// State read is diagnostic only; dispatch stays in the kernel. Restart retains identity.
export async function qualifyRefund({ profile, changedProfile, operationId, readState, restart, evidence }) {
  const stages = evidence.stages = [];
  try {
  const initialState = await readState();
  const before = await profile.observe(operationId, { all: true });
  evidence.before = refundEvidence(before);
  const matching = before.filter(r => r.metadata?.once_operation_id === operationId);
  assert.ok(matching.length <= 1, 'Existing duplicate effects require investigation');
  assert.ok(initialState !== null || matching.length === 0, 'Provider effect exists without authority history; no fresh dispatch permitted');
  const fresh = initialState === null && matching.length === 0;
  evidence.fresh = fresh;
  evidence.initialState = initialState;
  if (fresh) {
    await assert.rejects(profile.run(operationId, { loseAcknowledgement: true }), { code: 'UNKNOWN' });
    assert.deepEqual(profile.diagnostics(), { refundPosts: 1, injectedAcknowledgementLosses: 1 });
    assert.equal(await readState(), 'UNKNOWN');
    stages.push('fresh dispatch acknowledgement withheld; committed UNKNOWN verified');
  } else stages.push('existing operation: recovery/replay only; fresh-loss gate remains unsatisfied');
  evidence.firstProcess = profile.diagnostics();
  ({ profile, changedProfile } = await restart());
  if (fresh) {
    assert.equal(await readState(), 'UNKNOWN');
    await assert.rejects(profile.run(operationId, { withholdReconciliation: true }), { code: 'UNKNOWN' });
    assert.equal(await readState(), 'UNKNOWN');
    assert.equal(profile.diagnostics().refundPosts, 0);
    stages.push('new pools/authority preserved UNKNOWN; simulated unavailable truth blocked redispatch');
  }
  const result = await profile.run(operationId);
  assert.equal(await readState(), 'CONFIRMED');
  assert.deepEqual(await profile.run(operationId), result);
  await assert.rejects(changedProfile.run(operationId), { code: 'CONFLICT' });
  assert.equal(profile.diagnostics().refundPosts, 0, 'Recovery/replay must not dispatch');
  assert.equal(changedProfile.diagnostics().refundPosts, 0, 'Conflict must not dispatch');
  const after = await profile.observe(operationId, { all: true });
  evidence.after = refundEvidence(after);
  const effects = after.filter(r => r.metadata?.once_operation_id === operationId);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].id, result.refundId);
  assert.deepEqual(profile.validateObservedRefund(effects[0], operationId), result,
    'Independent provider truth must establish the exact terminal cached receipt');
  if (fresh) {
    const prior = new Set(before.map(r => r.id));
    const added = after.filter(r => !prior.has(r.id));
    assert.equal(added.length, 1, 'Designated payment gained more than one refund');
    assert.equal(added[0].id, result.refundId);
    assert.ok(before.every(r => after.some(a => a.id === r.id)), 'Provider history became incomplete');
  }
  stages.push('authoritative terminal refund reconciled; confirmed replay and changed-input conflict passed');
  evidence.recoveryProcess = profile.diagnostics();
  evidence.result = result;
  evidence.observedEffects = effects.length;
  evidence.status = 'TESTED';
  evidence.qualification = fresh ? 'FRESH_SANDBOX' : 'RECOVERY_ONLY';
  evidence.freshLostAcknowledgementQualified = fresh;
  return evidence;
  } finally {
    evidence.lastProfileDiagnostics = profile.diagnostics();
  }
}

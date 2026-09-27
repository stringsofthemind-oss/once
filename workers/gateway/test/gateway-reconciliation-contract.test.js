import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AmbiguousOutcomeError,
  GatewayCore,
  GatewayDecision,
  MemoryOperationStore,
  OutcomeState,
} from '../src/gateway-core.js';

function request(overrides = {}) {
  return {
    operationId: 'phase14c:operation',
    effectHash: 'hash:phase14c',
    conflictKey: 'phase14c:scope',
    payload: { amount: 100 },
    ...overrides,
  };
}

async function seedUnknown({ store, req = request() }) {
  await store.put(req.operationId, {
    operationId: req.operationId,
    effectHash: req.effectHash,
    conflictKey: req.conflictKey ?? null,
    state: OutcomeState.UNKNOWN,
    result: null,
    providerReference: null,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
  });
}

test('ABSENT_PROVEN returns to normal protected path and cannot bypass admission', async () => {
  const store = new MemoryOperationStore();
  await seedUnknown({ store });
  let executeCalls = 0;
  let preflightCalls = 0;
  const gateway = new GatewayCore({
    store,
    beforeProviderPreflight: async () => {
      preflightCalls += 1;
      throw new Error('tenant_not_admitted');
    },
  });
  const adapter = {
    async reconcile() { return { status: 'ABSENT_PROVEN', evidence: { method: 'authoritative-read' } }; },
    async execute() { executeCalls += 1; return { ok: true }; },
  };

  await assert.rejects(gateway.execute(request(), adapter), /tenant_not_admitted/);
  assert.equal(preflightCalls, 1);
  assert.equal(executeCalls, 0);
  assert.equal((await store.get(request().operationId)).state, OutcomeState.UNKNOWN);
});

test('legacy authoritative ABSENT still uses the same protected path', async () => {
  const store = new MemoryOperationStore();
  await seedUnknown({ store });
  let executeCalls = 0;
  const gateway = new GatewayCore({ store });
  const adapter = {
    async reconcile() { return { status: 'ABSENT', authoritative: true }; },
    async execute() { executeCalls += 1; return { ok: true, providerReference: 'legacy-ok' }; },
  };

  const result = await gateway.execute(request(), adapter);
  assert.equal(result.decision, GatewayDecision.EXECUTE);
  assert.equal(executeCalls, 1);
});

test('legacy non-authoritative ABSENT remains UNKNOWN', async () => {
  const store = new MemoryOperationStore();
  await seedUnknown({ store });
  let executeCalls = 0;
  const gateway = new GatewayCore({ store });
  const adapter = {
    async reconcile() { return { status: 'ABSENT', authoritative: false }; },
    async execute() { executeCalls += 1; return { ok: true }; },
  };

  const result = await gateway.execute(request(), adapter);
  assert.equal(result.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(executeCalls, 0);
  assert.equal((await store.get(request().operationId)).state, OutcomeState.UNKNOWN);
});

test('MISMATCH remains durably UNKNOWN and retains conflict fencing', async () => {
  const store = new MemoryOperationStore();
  await seedUnknown({ store });
  let executeCalls = 0;
  const gateway = new GatewayCore({ store });
  const adapter = {
    async reconcile() { return { status: 'MISMATCH', reason: 'immutable fields differ' }; },
    async execute() { executeCalls += 1; return { ok: true }; },
  };

  const result = await gateway.execute(request(), adapter);
  assert.equal(result.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(executeCalls, 0);
  assert.equal((await store.get(request().operationId)).state, OutcomeState.UNKNOWN);

  const competing = await gateway.execute(
    request({ operationId: 'phase14c:competing', effectHash: 'hash:competing' }),
    { async execute() { executeCalls += 1; return { ok: true }; } },
  );
  assert.equal(competing.decision, GatewayDecision.BLOCK_CONFLICT_SCOPE);
  assert.equal(competing.blockingOperationId, request().operationId);
  assert.equal(executeCalls, 0);
});

test('malformed and unrecognized reconciliation outcomes fail closed', async () => {
  for (const reconciliation of [null, [], 'CONFIRMED', { status: 'SUCCESS' }, { status: 'ABSENT' }]) {
    const store = new MemoryOperationStore();
    await seedUnknown({ store });
    let executeCalls = 0;
    const gateway = new GatewayCore({ store });
    const adapter = {
      async reconcile() { return reconciliation; },
      async execute() { executeCalls += 1; return { ok: true }; },
    };
    const result = await gateway.execute(request(), adapter);
    assert.equal(result.decision, GatewayDecision.BLOCK_UNKNOWN);
    assert.equal(executeCalls, 0);
  }
});

test('reconciliation throw stays UNKNOWN and cannot execute', async () => {
  const store = new MemoryOperationStore();
  await seedUnknown({ store });
  let executeCalls = 0;
  const gateway = new GatewayCore({ store });
  const adapter = {
    async reconcile() { throw new Error('network unavailable'); },
    async execute() { executeCalls += 1; return { ok: true }; },
  };

  const result = await gateway.execute(request(), adapter);
  assert.equal(result.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(executeCalls, 0);
});

test('CONFIRMED reconciliation persists confirmation and suppresses provider execution', async () => {
  const store = new MemoryOperationStore();
  await seedUnknown({ store });
  let executeCalls = 0;
  const gateway = new GatewayCore({ store });
  const adapter = {
    async reconcile() {
      return { status: 'CONFIRMED', result: { ok: true, reconciled: true }, providerReference: 'provider_14c' };
    },
    async execute() { executeCalls += 1; return { ok: true }; },
  };

  const result = await gateway.execute(request(), adapter);
  const record = await store.get(request().operationId);
  assert.equal(result.decision, GatewayDecision.REPLAY_CONFIRMED);
  assert.equal(executeCalls, 0);
  assert.equal(record.state, OutcomeState.CONFIRMED);
  assert.equal(record.providerReference, 'provider_14c');
});

test('authoritative absence does not execute from inside reconciliation', async () => {
  const store = new MemoryOperationStore();
  await seedUnknown({ store });
  const events = [];
  const gateway = new GatewayCore({
    store,
    beforeProviderPreflight: async () => { events.push('admission'); },
  });
  const adapter = {
    async reconcile() { events.push('reconcile'); return { status: 'ABSENT_PROVEN' }; },
    async preflight() { events.push('preflight'); },
    async execute() { events.push('execute'); return { ok: true }; },
  };

  const result = await gateway.execute(request(), adapter);
  assert.equal(result.decision, GatewayDecision.EXECUTE);
  assert.deepEqual(events, ['reconcile', 'admission', 'preflight', 'execute']);
});

test('first ambiguous attempt followed by ABSENT_PROVEN permits one ordinary retry then replay', async () => {
  const store = new MemoryOperationStore();
  const gateway = new GatewayCore({ store });
  let executeCalls = 0;
  const adapter = {
    async reconcile() { return { status: 'ABSENT_PROVEN' }; },
    async execute() {
      executeCalls += 1;
      if (executeCalls === 1) throw new AmbiguousOutcomeError('lost acknowledgement');
      return { ok: true, providerReference: 'retry-ok' };
    },
  };

  const first = await gateway.execute(request(), adapter);
  const retry = await gateway.execute(request(), adapter);
  const replay = await gateway.execute(request(), adapter);
  assert.equal(first.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(retry.decision, GatewayDecision.EXECUTE);
  assert.equal(replay.decision, GatewayDecision.REPLAY_CONFIRMED);
  assert.equal(executeCalls, 2);
});

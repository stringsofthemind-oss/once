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

test('restart before reconciliation preserves UNKNOWN and conflict fence', async () => {
  const store = new MemoryOperationStore();
  await seedUnknown({ store });

  // A new GatewayCore instance models a process/runtime restart while durable
  // operation state remains in the store.
  const restartedGateway = new GatewayCore({ store });
  let executeCalls = 0;
  const result = await restartedGateway.execute(request(), {
    async reconcile() { return { status: 'UNKNOWN', reason: 'still ambiguous' }; },
    async execute() { executeCalls += 1; return { ok: true }; },
  });

  assert.equal(result.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal((await store.get(request().operationId)).state, OutcomeState.UNKNOWN);

  const competing = await restartedGateway.execute(
    request({ operationId: 'phase14c:restart-competing', effectHash: 'hash:restart-competing' }),
    { async execute() { executeCalls += 1; return { ok: true }; } },
  );
  assert.equal(competing.decision, GatewayDecision.BLOCK_CONFLICT_SCOPE);
  assert.equal(competing.blockingOperationId, request().operationId);
  assert.equal(executeCalls, 0);
});

test('restart after durable reconciliation confirmation replays without provider execution', async () => {
  const store = new MemoryOperationStore();
  await seedUnknown({ store });
  let executeCalls = 0;
  const firstGateway = new GatewayCore({ store });
  const adapter = {
    async reconcile() {
      return { status: 'CONFIRMED', result: { ok: true, reconciled: true }, providerReference: 'restart-confirmed' };
    },
    async execute() { executeCalls += 1; return { ok: true }; },
  };

  const reconciled = await firstGateway.execute(request(), adapter);
  assert.equal(reconciled.decision, GatewayDecision.REPLAY_CONFIRMED);

  const restartedGateway = new GatewayCore({ store });
  const replay = await restartedGateway.execute(request(), adapter);
  assert.equal(replay.decision, GatewayDecision.REPLAY_CONFIRMED);
  assert.deepEqual(replay.result, { ok: true, reconciled: true });
  assert.equal(executeCalls, 0);
});

test('concurrent reconciliation attempts are serialized by conflict authority', async () => {
  const store = new MemoryOperationStore();
  await seedUnknown({ store });
  const gateway = new GatewayCore({ store });
  let activeReconciliations = 0;
  let maxActiveReconciliations = 0;
  let reconcileCalls = 0;
  let releaseFirst;
  const firstEntered = new Promise((resolve) => { releaseFirst = resolve; });
  let signalEntered;
  const entered = new Promise((resolve) => { signalEntered = resolve; });

  const adapter = {
    async reconcile() {
      reconcileCalls += 1;
      activeReconciliations += 1;
      maxActiveReconciliations = Math.max(maxActiveReconciliations, activeReconciliations);
      if (reconcileCalls === 1) {
        signalEntered();
        await firstEntered;
      }
      activeReconciliations -= 1;
      return { status: 'UNKNOWN' };
    },
    async execute() { throw new Error('must not execute'); },
  };

  const first = gateway.execute(request(), adapter);
  await entered;
  const second = gateway.execute(request(), adapter);
  releaseFirst();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(secondResult.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(reconcileCalls, 2);
  assert.equal(maxActiveReconciliations, 1);
});

test('reconciliation evidence is not persisted as a raw provider payload channel', async () => {
  const store = new MemoryOperationStore();
  await seedUnknown({ store });
  const gateway = new GatewayCore({ store });
  const secret = 'sk_live_must_not_persist';
  const result = await gateway.execute(request(), {
    async reconcile() {
      return {
        status: 'MISMATCH',
        reason: 'related object did not match',
        evidence: {
          method: 'provider-read',
          authorization: `Bearer ${secret}`,
          rawResponse: { secret, huge: 'provider-payload' },
        },
      };
    },
    async execute() { throw new Error('must not execute'); },
  });

  assert.equal(result.decision, GatewayDecision.BLOCK_UNKNOWN);
  const persisted = JSON.stringify(await store.get(request().operationId));
  assert.equal(persisted.includes(secret), false);
  assert.equal(persisted.includes('rawResponse'), false);
  assert.equal(persisted.includes('authorization'), false);
});

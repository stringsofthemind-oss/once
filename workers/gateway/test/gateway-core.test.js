import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AmbiguousOutcomeError,
  GatewayCore,
  GatewayDecision,
  MemoryOperationStore,
} from '../src/gateway-core.js';

function makeGateway() {
  return new GatewayCore({ store: new MemoryOperationStore(), clock: () => '2026-09-26T00:00:00.000Z' });
}

test('confirmed operation replays without a second provider effect', async () => {
  const gateway = makeGateway();
  let effects = 0;
  const adapter = {
    async execute() {
      effects += 1;
      return { ok: true, providerReference: `ref-${effects}` };
    },
    async reconcile() {
      throw new Error('reconcile should not run for confirmed replay');
    },
  };

  const request = { operationId: 'refund:1', effectHash: 'hash:a', payload: { amount: 10 } };
  const first = await gateway.execute(request, adapter);
  const second = await gateway.execute(request, adapter);

  assert.equal(first.decision, GatewayDecision.EXECUTE);
  assert.equal(second.decision, GatewayDecision.REPLAY_CONFIRMED);
  assert.equal(effects, 1);
});

test('lost acknowledgement reconciles provider truth and suppresses duplicate execution', async () => {
  const gateway = makeGateway();
  let effects = 0;
  let executeCalls = 0;
  const adapter = {
    async execute() {
      executeCalls += 1;
      effects += 1;
      throw new AmbiguousOutcomeError('commit happened but acknowledgement was lost');
    },
    async reconcile() {
      return { status: 'CONFIRMED', result: { ok: true, reconciled: true }, providerReference: 'refund_1' };
    },
  };

  const request = { operationId: 'refund:2', effectHash: 'hash:b', payload: { amount: 20 } };
  const first = await gateway.execute(request, adapter);
  const retry = await gateway.execute(request, adapter);

  assert.equal(first.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(retry.decision, GatewayDecision.REPLAY_CONFIRMED);
  assert.equal(executeCalls, 1);
  assert.equal(effects, 1);
});

test('provider truth unavailable stays fail-closed', async () => {
  const gateway = makeGateway();
  let executeCalls = 0;
  const adapter = {
    async execute() {
      executeCalls += 1;
      throw new AmbiguousOutcomeError();
    },
    async reconcile() {
      return { status: 'UNKNOWN' };
    },
  };

  const request = { operationId: 'email:1', effectHash: 'hash:c', payload: { to: 'a@example.test' } };
  await gateway.execute(request, adapter);
  const retry = await gateway.execute(request, adapter);

  assert.equal(retry.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(executeCalls, 1);
});

test('reconciliation transport failure stays fail-closed', async () => {
  const gateway = makeGateway();
  let executeCalls = 0;
  const adapter = {
    async execute() {
      executeCalls += 1;
      throw new AmbiguousOutcomeError();
    },
    async reconcile() {
      throw new Error('provider status endpoint unavailable');
    },
  };

  const request = { operationId: 'email:2', effectHash: 'hash:c2', payload: { to: 'b@example.test' } };
  await gateway.execute(request, adapter);
  const retry = await gateway.execute(request, adapter);

  assert.equal(retry.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(executeCalls, 1);
});

test('non-authoritative absence is treated as UNKNOWN', async () => {
  const gateway = makeGateway();
  let executeCalls = 0;
  const adapter = {
    async execute() {
      executeCalls += 1;
      throw new AmbiguousOutcomeError();
    },
    async reconcile() {
      return { status: 'ABSENT', authoritative: false };
    },
  };

  const request = { operationId: 'order:1', effectHash: 'hash:d', payload: { sku: 'x' } };
  await gateway.execute(request, adapter);
  const retry = await gateway.execute(request, adapter);

  assert.equal(retry.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(executeCalls, 1);
});

test('authoritative absence permits exactly one new execution attempt', async () => {
  const gateway = makeGateway();
  let executeCalls = 0;
  const adapter = {
    async execute() {
      executeCalls += 1;
      if (executeCalls === 1) throw new AmbiguousOutcomeError();
      return { ok: true };
    },
    async reconcile() {
      return { status: 'ABSENT', authoritative: true };
    },
  };

  const request = { operationId: 'deploy:1', effectHash: 'hash:e', payload: { target: 'prod' } };
  await gateway.execute(request, adapter);
  const retry = await gateway.execute(request, adapter);
  const replay = await gateway.execute(request, adapter);

  assert.equal(retry.decision, GatewayDecision.EXECUTE);
  assert.equal(replay.decision, GatewayDecision.REPLAY_CONFIRMED);
  assert.equal(executeCalls, 2);
});

test('same logical identity with different effect hash is rejected', async () => {
  const gateway = makeGateway();
  let effects = 0;
  const adapter = {
    async execute() {
      effects += 1;
      return { ok: true };
    },
    async reconcile() {
      return { status: 'UNKNOWN' };
    },
  };

  await gateway.execute({ operationId: 'refund:3', effectHash: 'hash:one', payload: { amount: 10 } }, adapter);
  const conflict = await gateway.execute({ operationId: 'refund:3', effectHash: 'hash:two', payload: { amount: 20 } }, adapter);

  assert.equal(conflict.decision, GatewayDecision.CONFLICT);
  assert.equal(effects, 1);
});

test('concurrent delivery of the same logical operation produces one provider effect', async () => {
  const gateway = makeGateway();
  let effects = 0;
  let releaseExecution;
  const executionGate = new Promise((resolve) => {
    releaseExecution = resolve;
  });
  let firstEntered;
  const firstEnteredGate = new Promise((resolve) => {
    firstEntered = resolve;
  });

  const adapter = {
    async execute() {
      effects += 1;
      firstEntered();
      await executionGate;
      return { ok: true, providerReference: 'concurrent-1' };
    },
    async reconcile() {
      throw new Error('reconcile should not run after serialized confirmed execution');
    },
  };

  const request = { operationId: 'refund:concurrent', effectHash: 'hash:concurrent', payload: { amount: 30 } };
  const first = gateway.execute(request, adapter);
  await firstEnteredGate;
  const second = gateway.execute(request, adapter);
  releaseExecution();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.decision, GatewayDecision.EXECUTE);
  assert.equal(secondResult.decision, GatewayDecision.REPLAY_CONFIRMED);
  assert.equal(effects, 1);
});

test('BYPASS does not create durable protection state', async () => {
  const store = new MemoryOperationStore();
  const gateway = new GatewayCore({ store });
  let calls = 0;
  const adapter = {
    async execute() {
      calls += 1;
      return { ok: true };
    },
  };

  const request = { operationId: 'search:1', effectHash: 'hash:search', protection: 'BYPASS' };
  const first = await gateway.execute(request, adapter);
  const second = await gateway.execute(request, adapter);

  assert.equal(first.decision, GatewayDecision.BYPASS);
  assert.equal(second.decision, GatewayDecision.BYPASS);
  assert.equal(calls, 2);
  assert.equal(await store.get('search:1'), null);
});

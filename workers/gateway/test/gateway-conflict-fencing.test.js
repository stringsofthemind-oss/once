import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AmbiguousOutcomeError,
  GatewayCore,
  GatewayDecision,
  MemoryOperationStore,
} from '../src/gateway-core.js';

function makeGateway() {
  return new GatewayCore({
    store: new MemoryOperationStore(),
    clock: () => '2026-09-27T00:00:00.000Z',
  });
}

function unknownAdapter(counter) {
  return {
    async execute() {
      counter.calls += 1;
      throw new AmbiguousOutcomeError('effect may have happened');
    },
    async reconcile() {
      return { status: 'UNKNOWN' };
    },
  };
}

test('UNKNOWN fences a fresh operation ID on the same conflict scope', async () => {
  const gateway = makeGateway();
  const firstCounter = { calls: 0 };
  const secondCounter = { calls: 0 };

  const first = {
    operationId: 'listing:product-123:v7',
    effectHash: 'hash:v7',
    conflictKey: 'smartstore:account-42:product-123',
    payload: { title: 'v7' },
  };
  const second = {
    operationId: 'listing:product-123:v8',
    effectHash: 'hash:v8',
    conflictKey: 'smartstore:account-42:product-123',
    payload: { title: 'v8' },
  };

  const ambiguous = await gateway.execute(first, unknownAdapter(firstCounter));
  const blocked = await gateway.execute(second, unknownAdapter(secondCounter));

  assert.equal(ambiguous.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(blocked.decision, GatewayDecision.BLOCK_CONFLICT_SCOPE);
  assert.equal(blocked.blockingOperationId, first.operationId);
  assert.equal(blocked.conflictKey, first.conflictKey);
  assert.equal(firstCounter.calls, 1);
  assert.equal(secondCounter.calls, 0);
});

test('changed payload cannot escape an unresolved UNKNOWN by using a fresh operation ID', async () => {
  const gateway = makeGateway();
  const counter = { calls: 0 };
  const adapter = unknownAdapter(counter);
  const conflictKey = 'market:account-7:item-99';

  await gateway.execute({
    operationId: 'register:item-99:v1',
    effectHash: 'hash:old',
    conflictKey,
    payload: { price: 100 },
  }, adapter);

  const blocked = await gateway.execute({
    operationId: 'register:item-99:v2',
    effectHash: 'hash:new',
    conflictKey,
    payload: { price: 120 },
  }, adapter);

  assert.equal(blocked.decision, GatewayDecision.BLOCK_CONFLICT_SCOPE);
  assert.equal(counter.calls, 1);
});

test('unrelated conflict scopes remain independently executable', async () => {
  const gateway = makeGateway();
  const firstCounter = { calls: 0 };
  const secondCounter = { calls: 0 };

  await gateway.execute({
    operationId: 'listing:a:v1',
    effectHash: 'hash:a',
    conflictKey: 'market:account-1:item-a',
  }, unknownAdapter(firstCounter));

  const result = await gateway.execute({
    operationId: 'listing:b:v1',
    effectHash: 'hash:b',
    conflictKey: 'market:account-1:item-b',
  }, {
    async execute() {
      secondCounter.calls += 1;
      return { ok: true };
    },
    async reconcile() {
      return { status: 'UNKNOWN' };
    },
  });

  assert.equal(result.decision, GatewayDecision.EXECUTE);
  assert.equal(firstCounter.calls, 1);
  assert.equal(secondCounter.calls, 1);
});

test('same operation ID cannot be rebound to a different conflict scope', async () => {
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

  await gateway.execute({
    operationId: 'payment:9281',
    effectHash: 'hash:payment',
    conflictKey: 'customer:1:payment',
  }, adapter);

  const conflict = await gateway.execute({
    operationId: 'payment:9281',
    effectHash: 'hash:payment',
    conflictKey: 'customer:2:payment',
  }, adapter);

  assert.equal(conflict.decision, GatewayDecision.CONFLICT);
  assert.equal(effects, 1);
});

test('concurrent different operation IDs sharing a conflict scope do not both cross provider boundary', async () => {
  const gateway = makeGateway();
  let effects = 0;
  let releaseFirst;
  let firstEntered;
  const executionGate = new Promise((resolve) => { releaseFirst = resolve; });
  const enteredGate = new Promise((resolve) => { firstEntered = resolve; });
  const conflictKey = 'remote:host-1:path-/critical';

  const first = gateway.execute({
    operationId: 'write:v1',
    effectHash: 'hash:write-v1',
    conflictKey,
  }, {
    async execute() {
      effects += 1;
      firstEntered();
      await executionGate;
      throw new AmbiguousOutcomeError();
    },
    async reconcile() {
      return { status: 'UNKNOWN' };
    },
  });

  await enteredGate;

  const second = gateway.execute({
    operationId: 'write:v2',
    effectHash: 'hash:write-v2',
    conflictKey,
  }, {
    async execute() {
      effects += 1;
      return { ok: true };
    },
    async reconcile() {
      return { status: 'UNKNOWN' };
    },
  });

  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(secondResult.decision, GatewayDecision.BLOCK_CONFLICT_SCOPE);
  assert.equal(secondResult.blockingOperationId, 'write:v1');
  assert.equal(effects, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GatewayCore,
  MemoryOperationStore,
  OutcomeState,
} from '../src/gateway-core.js';

test('deterministic adapter preflight failure happens before durable UNKNOWN', async () => {
  const store = new MemoryOperationStore();
  const gateway = new GatewayCore({ store });
  let executeCalls = 0;

  await assert.rejects(
    gateway.execute(
      {
        operationId: 'preflight-failure',
        effectHash: 'hash-a',
        payload: {},
      },
      {
        async preflight() {
          throw new Error('credentials unavailable');
        },
        async execute() {
          executeCalls += 1;
          return {};
        },
      },
    ),
    /credentials unavailable/,
  );

  assert.equal(executeCalls, 0);
  assert.equal(await store.get('preflight-failure'), null);
});

test('confirmed replay does not require adapter preflight or provider credentials', async () => {
  const store = new MemoryOperationStore();
  await store.put('confirmed', {
    operationId: 'confirmed',
    effectHash: 'hash-confirmed',
    state: OutcomeState.CONFIRMED,
    result: { providerReference: 'effect_1' },
    providerReference: 'effect_1',
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
  });

  const gateway = new GatewayCore({ store });
  let preflightCalls = 0;
  let executeCalls = 0;

  const result = await gateway.execute(
    {
      operationId: 'confirmed',
      effectHash: 'hash-confirmed',
      payload: {},
    },
    {
      async preflight() {
        preflightCalls += 1;
        throw new Error('must not run');
      },
      async execute() {
        executeCalls += 1;
        throw new Error('must not run');
      },
    },
  );

  assert.equal(result.decision, 'REPLAY_CONFIRMED');
  assert.equal(result.result.providerReference, 'effect_1');
  assert.equal(preflightCalls, 0);
  assert.equal(executeCalls, 0);
});

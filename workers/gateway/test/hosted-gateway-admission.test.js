import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HostedGatewayCore,
  HostedGatewayError,
  computeHostedEffectHash,
} from '../src/hosted-gateway-core.js';

class MemoryStorage {
  constructor() {
    this.records = new Map();
  }
  async get(key) {
    return this.records.get(key) ?? null;
  }
  async put(key, value) {
    this.records.set(key, structuredClone(value));
  }
}

function body(amount = 100) {
  return {
    operation_id: 'op_1',
    target: { provider: 'fixture', action: 'effect.create' },
    payload: { resource: 'r1', amount },
  };
}

function registration(events) {
  return {
    protection: 'PROTECT',
    bindingVersion: 'fixture-v1',
    canonicalizeEffect(payload) {
      events.push('canonicalize');
      return { resource: String(payload.resource), amount: Number(payload.amount) };
    },
    createAdapter() {
      events.push('adapter_construct');
      return {
        async execute() {
          events.push('provider_execute');
          return { providerReference: 'effect_1' };
        },
        async reconcile() {
          events.push('provider_reconcile');
          return { status: 'UNKNOWN' };
        },
      };
    },
  };
}

test('admission runs after authoritative effect binding and before adapter/provider construction', async () => {
  const events = [];
  let admissionContext;
  const core = new HostedGatewayCore({
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return { tenantId: 'tenant_a', keyId: 'key_a' };
      },
    },
    storage: new MemoryStorage(),
    resolveRegistration: async () => registration(events),
    admissionPolicy: {
      async authorize(context) {
        events.push('admission');
        admissionContext = context;
        return { plan: 'pro', used: 1, limit: 100_000, metered: true };
      },
    },
  });

  const result = await core.execute({ authorization: 'Bearer once_test_a', body: body() });

  assert.deepEqual(events, [
    'authenticate',
    'canonicalize',
    'admission',
    'adapter_construct',
    'provider_execute',
  ]);
  assert.equal(admissionContext.tenantId, 'tenant_a');
  assert.equal(admissionContext.operationId, 'op_1');
  assert.equal(admissionContext.provider, 'fixture');
  assert.equal(admissionContext.action, 'effect.create');
  assert.equal(admissionContext.bindingVersion, 'fixture-v1');
  assert.equal(admissionContext.protection, 'PROTECT');
  assert.match(admissionContext.effectHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(admissionContext.providerOperationKey, /^once_hv1_[a-f0-9]{64}$/);
  assert.deepEqual(result.admission, { plan: 'pro', used: 1, limit: 100_000, metered: true });
});

test('admission denial prevents adapter construction and provider crossing', async () => {
  const events = [];
  const core = new HostedGatewayCore({
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return { tenantId: 'tenant_a', keyId: 'key_a' };
      },
    },
    storage: new MemoryStorage(),
    resolveRegistration: async () => registration(events),
    admissionPolicy: {
      async authorize() {
        events.push('admission');
        throw new HostedGatewayError('monthly_limit_exceeded', 429);
      },
    },
  });

  await assert.rejects(
    core.execute({ authorization: 'Bearer once_test_a', body: body() }),
    (error) => error instanceof HostedGatewayError && error.code === 'monthly_limit_exceeded',
  );
  assert.deepEqual(events, ['authenticate', 'canonicalize', 'admission']);
});

test('effect-hash mismatch is rejected before admission', async () => {
  const events = [];
  let admissionCalls = 0;
  const canonicalEffect = { resource: 'r1', amount: 100 };
  const wrongHash = await computeHostedEffectHash({
    provider: 'fixture',
    action: 'effect.create',
    bindingVersion: 'fixture-v1',
    canonicalEffect: { resource: 'different', amount: 100 },
  });

  const core = new HostedGatewayCore({
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return { tenantId: 'tenant_a', keyId: 'key_a' };
      },
    },
    storage: new MemoryStorage(),
    resolveRegistration: async () => ({
      ...registration(events),
      canonicalizeEffect() {
        events.push('canonicalize');
        return canonicalEffect;
      },
    }),
    admissionPolicy: {
      async authorize() {
        admissionCalls += 1;
      },
    },
  });

  await assert.rejects(
    core.execute({
      authorization: 'Bearer once_test_a',
      body: { ...body(), effect_hash: wrongHash },
    }),
    (error) => error instanceof HostedGatewayError && error.code === 'effect_hash_mismatch',
  );
  assert.equal(admissionCalls, 0);
  assert.deepEqual(events, ['authenticate', 'canonicalize']);
});

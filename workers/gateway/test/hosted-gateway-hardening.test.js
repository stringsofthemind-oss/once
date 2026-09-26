import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiKeyAuthenticator,
  HostedGatewayCore,
  canonicalJson,
  sha256Hex,
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

async function authenticatorFor(rawKey, tenantId) {
  const expected = await sha256Hex(rawKey);
  return new ApiKeyAuthenticator({
    keyStore: {
      async findActiveByHash(hash) {
        return hash === expected ? { tenantId } : null;
      },
    },
  });
}

function body() {
  return {
    operation_id: 'refund:lazy-replay',
    target: { provider: 'stripe', action: 'refund.create' },
    payload: { payment_intent: 'pi_lazy', amount: 100 },
  };
}

test('confirmed replay does not require provider credentials or adapter construction', async () => {
  const auth = await authenticatorFor('once_test_lazy', 'tenant-lazy');
  const storage = new MemoryStorage();
  let createAdapterCalls = 0;
  let providerEffects = 0;
  let providerAvailable = true;

  const hosted = new HostedGatewayCore({
    authenticator: auth,
    storage,
    resolveRegistration: async () => ({
      protection: 'PROTECT',
      bindingVersion: 'v1',
      canonicalizeEffect(payload) {
        return { payment_intent: payload.payment_intent, amount: payload.amount };
      },
      async createAdapter() {
        createAdapterCalls += 1;
        if (!providerAvailable) throw new Error('provider credential revoked');
        return {
          async execute() {
            providerEffects += 1;
            return { providerReference: 're_lazy' };
          },
          async reconcile() {
            return { status: 'UNKNOWN' };
          },
        };
      },
    }),
  });

  const first = await hosted.execute({ authorization: 'Bearer once_test_lazy', body: body() });
  providerAvailable = false;
  const replay = await hosted.execute({ authorization: 'Bearer once_test_lazy', body: body() });

  assert.equal(first.decision, 'EXECUTE');
  assert.equal(replay.decision, 'REPLAY_CONFIRMED');
  assert.equal(providerEffects, 1);
  assert.equal(createAdapterCalls, 1);
});

test('durable record includes tenant and server-owned provider binding context', async () => {
  const auth = await authenticatorFor('once_test_context', 'tenant-context');
  const storage = new MemoryStorage();
  const hosted = new HostedGatewayCore({
    authenticator: auth,
    storage,
    resolveRegistration: async () => ({
      protection: 'PROTECT',
      bindingVersion: 'refund-v3',
      canonicalizeEffect(payload) {
        return { payment_intent: payload.payment_intent, amount: payload.amount };
      },
      async createAdapter() {
        return {
          async execute() {
            return { providerReference: 're_context' };
          },
          async reconcile() {
            return { status: 'UNKNOWN' };
          },
        };
      },
    }),
  });

  await hosted.execute({ authorization: 'Bearer once_test_context', body: body() });
  assert.equal(storage.records.size, 1);
  const record = [...storage.records.values()][0];
  assert.equal(record.tenantId, 'tenant-context');
  assert.equal(record.provider, 'stripe');
  assert.equal(record.action, 'refund.create');
  assert.equal(record.bindingVersion, 'refund-v3');
  assert.match(record.providerOperationKey, /^once_hv1_[a-f0-9]{64}$/);
  assert.equal(record.state, 'CONFIRMED');
});

test('canonical binding fails closed on non-finite and unsupported values', () => {
  assert.throws(() => canonicalJson({ amount: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ amount: Number.POSITIVE_INFINITY }), /non-finite/);
  assert.throws(() => canonicalJson({ missing: undefined }), /unsupported undefined/);
  assert.throws(() => canonicalJson({ value: 1n }), /unsupported bigint/);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiKeyAuthenticator,
  HostedGatewayCore,
  HostedGatewayError,
  computeHostedEffectHash,
  deriveProviderOperationKey,
  deriveTenantOperationKey,
  sha256Hex,
} from '../src/hosted-gateway-core.js';
import { AmbiguousOutcomeError } from '../src/gateway-core.js';

class MemoryStorage {
  constructor() { this.records = new Map(); }
  async get(key) { return this.records.get(key) ?? null; }
  async put(key, value) { this.records.set(key, structuredClone(value)); }
}

async function makeAuthenticator(entries) {
  const byHash = new Map();
  for (const [rawKey, record] of entries) byHash.set(await sha256Hex(rawKey), record);
  return new ApiKeyAuthenticator({ keyStore: { async findActiveByHash(hash) { return byHash.get(hash) ?? null; } } });
}

function makeRegistration({ effects, gate, capture, protection = 'PROTECT', bindingVersion = 'v1', ambiguous = false } = {}) {
  return {
    protection,
    bindingVersion,
    canonicalizeEffect(payload) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HostedGatewayError('invalid_payload', 400);
      return { payment_intent: String(payload.payment_intent || ''), amount: Number(payload.amount) };
    },
    async createAdapter(context) {
      capture?.push(context);
      return {
        async execute({ metadata }) {
          if (effects) effects.count += 1;
          if (gate) { gate.entered?.(); await gate.wait; }
          if (ambiguous) throw new AmbiguousOutcomeError('provider may have committed');
          return { providerReference: `re_${effects?.count ?? 1}`, providerOperationKey: metadata?.hosted?.providerOperationKey };
        },
        async reconcile() { return { status: 'UNKNOWN' }; },
      };
    },
  };
}

function requestBody(overrides = {}) {
  return { operation_id: 'refund:order-123', target: { provider: 'stripe', action: 'refund.create' }, payload: { payment_intent: 'pi_123', amount: 100 }, ...overrides };
}

test('authenticator resolves only active hashed API keys and never passes raw key to store lookup', async () => {
  const rawKey = 'once_test_abcdef123456'; const expectedHash = await sha256Hex(rawKey); let lookupValue;
  const authenticator = new ApiKeyAuthenticator({ keyStore: { async findActiveByHash(hash) { lookupValue = hash; return hash === expectedHash ? { tenantId: 'tenant-a', keyId: 'key-a' } : null; } } });
  const principal = await authenticator.authenticate(`Bearer ${rawKey}`);
  assert.deepEqual(principal, { tenantId: 'tenant-a', keyId: 'key-a' }); assert.equal(lookupValue, expectedHash); assert.notEqual(lookupValue, rawKey);
  await assert.rejects(authenticator.authenticate('Bearer once_test_wrong'), (error) => error instanceof HostedGatewayError && error.code === 'invalid_api_key' && error.status === 401);
});

test('same logical operation id is isolated across tenants', async () => {
  const authenticator = await makeAuthenticator([['once_test_tenant_a', { tenantId: 'tenant-a', keyId: 'a' }], ['once_test_tenant_b', { tenantId: 'tenant-b', keyId: 'b' }]]);
  const storage = new MemoryStorage(); const effectsA = { count: 0 }; const effectsB = { count: 0 };
  const hosted = new HostedGatewayCore({ authenticator, storage, resolveRegistration: async ({ tenantId }) => tenantId === 'tenant-a' ? makeRegistration({ effects: effectsA }) : makeRegistration({ effects: effectsB }) });
  const a1 = await hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody() }); const b1 = await hosted.execute({ authorization: 'Bearer once_test_tenant_b', body: requestBody() });
  const a2 = await hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody() }); const b2 = await hosted.execute({ authorization: 'Bearer once_test_tenant_b', body: requestBody() });
  assert.equal(a1.decision, 'EXECUTE'); assert.equal(b1.decision, 'EXECUTE'); assert.equal(a2.decision, 'REPLAY_CONFIRMED'); assert.equal(b2.decision, 'REPLAY_CONFIRMED'); assert.equal(effectsA.count, 1); assert.equal(effectsB.count, 1); assert.equal(storage.records.size, 2);
});

test('concurrent identical deliveries in one tenant serialize to one effect', async () => {
  const authenticator = await makeAuthenticator([['once_test_tenant_a', { tenantId: 'tenant-a' }]]); const storage = new MemoryStorage(); const effects = { count: 0 };
  let release; const wait = new Promise((resolve) => { release = resolve; }); let firstEntered; const entered = new Promise((resolve) => { firstEntered = resolve; }); let enteredOnce = false;
  const gate = { wait, entered() { if (!enteredOnce) { enteredOnce = true; firstEntered(); } } };
  const hosted = new HostedGatewayCore({ authenticator, storage, resolveRegistration: async () => makeRegistration({ effects, gate }) });
  const first = hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody() }); await entered; const second = hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody() }); release();
  const [firstResult, secondResult] = await Promise.all([first, second]); assert.equal(firstResult.decision, 'EXECUTE'); assert.equal(secondResult.decision, 'REPLAY_CONFIRMED'); assert.equal(effects.count, 1);
});

test('server recomputes effect binding and rejects a client hash mismatch before provider execution', async () => {
  const authenticator = await makeAuthenticator([['once_test_tenant_a', { tenantId: 'tenant-a' }]]); const storage = new MemoryStorage(); const effects = { count: 0 };
  const hosted = new HostedGatewayCore({ authenticator, storage, resolveRegistration: async () => makeRegistration({ effects }) });
  await assert.rejects(hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody({ effect_hash: 'sha256:not-the-server-binding' }) }), (error) => error instanceof HostedGatewayError && error.code === 'effect_hash_mismatch');
  assert.equal(effects.count, 0); assert.equal(storage.records.size, 0);
});

test('client cannot downgrade a protected registered action to BYPASS', async () => {
  const authenticator = await makeAuthenticator([['once_test_tenant_a', { tenantId: 'tenant-a' }]]); const effects = { count: 0 };
  const hosted = new HostedGatewayCore({ authenticator, storage: new MemoryStorage(), resolveRegistration: async () => makeRegistration({ effects, protection: 'PROTECT' }) });
  await assert.rejects(hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody({ protection: 'BYPASS' }) }), (error) => error instanceof HostedGatewayError && error.code === 'protection_policy_mismatch');
  assert.equal(effects.count, 0);
});

test('provider/action drift under the same logical identity conflicts even when payload is unchanged', async () => {
  const authenticator = await makeAuthenticator([['once_test_tenant_a', { tenantId: 'tenant-a' }]]); const storage = new MemoryStorage(); const effects = { count: 0 };
  const hosted = new HostedGatewayCore({ authenticator, storage, resolveRegistration: async () => makeRegistration({ effects }) });
  const first = await hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody() });
  const conflict = await hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody({ target: { provider: 'stripe', action: 'refund.cancel' } }) });
  assert.equal(first.decision, 'EXECUTE'); assert.equal(conflict.decision, 'CONFLICT'); assert.equal(effects.count, 1);
});

test('provider-native idempotency namespace differs across tenants for the same operation id', async () => {
  const a = await deriveProviderOperationKey({ tenantId: 'tenant-a', operationId: 'refund:same', provider: 'stripe', action: 'refund.create' });
  const b = await deriveProviderOperationKey({ tenantId: 'tenant-b', operationId: 'refund:same', provider: 'stripe', action: 'refund.create' });
  assert.notEqual(a, b); assert.match(a, /^once_hv1_[a-f0-9]{64}$/); assert.match(b, /^once_hv1_[a-f0-9]{64}$/);
});

test('client can optionally send the exact server-derived effect hash', async () => {
  const authenticator = await makeAuthenticator([['once_test_tenant_a', { tenantId: 'tenant-a' }]]); const storage = new MemoryStorage(); const effects = { count: 0 };
  const exact = await computeHostedEffectHash({ provider: 'stripe', action: 'refund.create', canonicalEffect: { payment_intent: 'pi_123', amount: 100 } });
  const hosted = new HostedGatewayCore({ authenticator, storage, resolveRegistration: async () => makeRegistration({ effects }) });
  const result = await hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody({ effect_hash: exact }) });
  assert.equal(result.decision, 'EXECUTE'); assert.equal(result.effectHash, exact); assert.equal(effects.count, 1);
});

test('durable UNKNOWN conflict fence blocks a fresh operation after HostedGatewayCore restart', async () => {
  const authenticator = await makeAuthenticator([['once_test_tenant_a', { tenantId: 'tenant-a' }]]);
  const storage = new MemoryStorage(); const effects = { count: 0 };
  const resolveRegistration = async () => makeRegistration({ effects, ambiguous: true });
  const firstHost = new HostedGatewayCore({ authenticator, storage, resolveRegistration });
  const first = await firstHost.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody({ operation_id: 'refund:v1', conflict_key: 'stripe:pi_123:refund' }) });
  assert.equal(first.decision, 'BLOCK_UNKNOWN'); assert.equal(effects.count, 1);

  // Simulate a process/runtime restart: new HostedGatewayCore and new serial authority,
  // but the same durable storage.
  const restartedHost = new HostedGatewayCore({ authenticator, storage, resolveRegistration });
  const second = await restartedHost.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody({ operation_id: 'refund:v2', conflict_key: 'stripe:pi_123:refund', payload: { payment_intent: 'pi_123', amount: 200 } }) });
  assert.equal(second.decision, 'BLOCK_CONFLICT_SCOPE');
  assert.equal(second.blockingOperationId, 'refund:v1');
  assert.equal(effects.count, 1);
});

test('conflict fences are tenant scoped', async () => {
  const authenticator = await makeAuthenticator([['once_test_tenant_a', { tenantId: 'tenant-a' }], ['once_test_tenant_b', { tenantId: 'tenant-b' }]]);
  const storage = new MemoryStorage(); const effectsA = { count: 0 }; const effectsB = { count: 0 };
  const hosted = new HostedGatewayCore({ authenticator, storage, resolveRegistration: async ({ tenantId }) => tenantId === 'tenant-a' ? makeRegistration({ effects: effectsA, ambiguous: true }) : makeRegistration({ effects: effectsB }) });
  const a = await hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody({ operation_id: 'refund:a', conflict_key: 'shared-looking-scope' }) });
  const b = await hosted.execute({ authorization: 'Bearer once_test_tenant_b', body: requestBody({ operation_id: 'refund:b', conflict_key: 'shared-looking-scope' }) });
  assert.equal(a.decision, 'BLOCK_UNKNOWN'); assert.equal(b.decision, 'EXECUTE'); assert.equal(effectsA.count, 1); assert.equal(effectsB.count, 1);
});

test('legacy CONFIRMED record without conflictKey still replays after upgrade', async () => {
  const authenticator = await makeAuthenticator([['once_test_tenant_a', { tenantId: 'tenant-a' }]]);
  const storage = new MemoryStorage(); const effects = { count: 0 };
  const operationId = 'refund:legacy-confirmed';
  const effectHash = await computeHostedEffectHash({ provider: 'stripe', action: 'refund.create', canonicalEffect: { payment_intent: 'pi_123', amount: 100 } });
  const providerOperationKey = await deriveProviderOperationKey({ tenantId: 'tenant-a', operationId, provider: 'stripe', action: 'refund.create' });
  storage.records.set(await deriveTenantOperationKey('tenant-a', operationId), {
    operationId, tenantId: 'tenant-a', effectHash, state: 'CONFIRMED', result: { providerReference: 're_legacy' }, providerReference: 're_legacy',
    provider: 'stripe', action: 'refund.create', bindingVersion: 'v1', providerOperationKey,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:01.000Z',
  });
  const hosted = new HostedGatewayCore({ authenticator, storage, resolveRegistration: async () => makeRegistration({ effects }) });
  const replay = await hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody({ operation_id: operationId }) });
  assert.equal(replay.decision, 'REPLAY_CONFIRMED'); assert.equal(replay.result.providerReference, 're_legacy'); assert.equal(effects.count, 0);
});

test('legacy UNKNOWN record without conflictKey keeps legacy reconcile-before-retry behavior', async () => {
  const authenticator = await makeAuthenticator([['once_test_tenant_a', { tenantId: 'tenant-a' }]]);
  const storage = new MemoryStorage(); const effects = { count: 0 };
  const operationId = 'refund:legacy-unknown';
  const effectHash = await computeHostedEffectHash({ provider: 'stripe', action: 'refund.create', canonicalEffect: { payment_intent: 'pi_123', amount: 100 } });
  const providerOperationKey = await deriveProviderOperationKey({ tenantId: 'tenant-a', operationId, provider: 'stripe', action: 'refund.create' });
  storage.records.set(await deriveTenantOperationKey('tenant-a', operationId), {
    operationId, tenantId: 'tenant-a', effectHash, state: 'UNKNOWN', result: null, providerReference: null,
    provider: 'stripe', action: 'refund.create', bindingVersion: 'v1', providerOperationKey,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:01.000Z',
  });
  const hosted = new HostedGatewayCore({ authenticator, storage, resolveRegistration: async () => makeRegistration({ effects }) });
  const result = await hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody({ operation_id: operationId }) });
  assert.equal(result.decision, 'BLOCK_UNKNOWN'); assert.equal(effects.count, 0);
});

test('legacy operation cannot be silently rebound to a new conflictKey after upgrade', async () => {
  const authenticator = await makeAuthenticator([['once_test_tenant_a', { tenantId: 'tenant-a' }]]);
  const storage = new MemoryStorage(); const effects = { count: 0 };
  const operationId = 'refund:legacy-rebind';
  const effectHash = await computeHostedEffectHash({ provider: 'stripe', action: 'refund.create', canonicalEffect: { payment_intent: 'pi_123', amount: 100 } });
  const providerOperationKey = await deriveProviderOperationKey({ tenantId: 'tenant-a', operationId, provider: 'stripe', action: 'refund.create' });
  storage.records.set(await deriveTenantOperationKey('tenant-a', operationId), {
    operationId, tenantId: 'tenant-a', effectHash, state: 'UNKNOWN', result: null, providerReference: null,
    provider: 'stripe', action: 'refund.create', bindingVersion: 'v1', providerOperationKey,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:01.000Z',
  });
  const hosted = new HostedGatewayCore({ authenticator, storage, resolveRegistration: async () => makeRegistration({ effects }) });
  const conflict = await hosted.execute({ authorization: 'Bearer once_test_tenant_a', body: requestBody({ operation_id: operationId, conflict_key: 'stripe:pi_123:refund' }) });
  assert.equal(conflict.decision, 'CONFLICT'); assert.equal(effects.count, 0);
});

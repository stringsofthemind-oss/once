import test from 'node:test';
import assert from 'node:assert/strict';

import { KeyedSerialAuthority, TenantScopedOperationStore } from '../src/hosted-gateway-core.js';

test('tenant and provider record context cannot be overridden by record data', async () => {
  let stored;
  const storage = {
    async get() {
      return null;
    },
    async put(key, value) {
      stored = { key, value };
    },
  };

  const store = new TenantScopedOperationStore({
    tenantId: 'tenant_server',
    storage,
    authority: new KeyedSerialAuthority(),
    recordContext: {
      provider: 'stripe',
      action: 'refund.create',
      bindingVersion: 'stripe-refund-v1',
      providerOperationKey: 'once_hv1_server',
    },
  });

  await store.put('operation-server', {
    operationId: 'operation-attacker',
    tenantId: 'tenant_attacker',
    provider: 'attacker',
    action: 'unsafe',
    bindingVersion: 'attacker-v1',
    providerOperationKey: 'attacker-key',
    effectHash: 'sha256:test',
    state: 'UNKNOWN',
  });

  assert.match(stored.key, /^tenant_v1_[a-f0-9]{64}$/);
  assert.equal(stored.value.operationId, 'operation-server');
  assert.equal(stored.value.tenantId, 'tenant_server');
  assert.equal(stored.value.provider, 'stripe');
  assert.equal(stored.value.action, 'refund.create');
  assert.equal(stored.value.bindingVersion, 'stripe-refund-v1');
  assert.equal(stored.value.providerOperationKey, 'once_hv1_server');
});

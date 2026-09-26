import test from 'node:test';
import assert from 'node:assert/strict';

import { sha256Hex } from '../../gateway/src/hosted-gateway-core.js';
import { RuntimeHostedGatewayBinding } from '../src/hosted-gateway-durable.mjs';
import {
  handleHostedGatewayInternalRequest,
  INTERNAL_HOSTED_EXECUTE_PATH,
} from '../src/hosted-gateway-transport.mjs';
import { createHostedStripeRefundResolver } from '../src/hosted-stripe-refund-registration.mjs';
import { storage } from './harness.mjs';

async function seedApiKey(store, rawKey, tenantId) {
  store.sql.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key_id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      customer_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `);
  store.sql.exec(
    `INSERT INTO api_keys (key_id, key_hash, customer_id, created_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`,
    `key_${tenantId}`,
    await sha256Hex(rawKey),
    tenantId,
    new Date().toISOString(),
  );
}

test('credential-store failure is opaque 503 before durable UNKNOWN or Stripe access', async () => {
  const store = storage();
  try {
    const rawKey = 'once_test_credential_failure';
    await seedApiKey(store, rawKey, 'tenant_credential_failure');
    let providerCalls = 0;

    const resolver = createHostedStripeRefundResolver({
      getSecretKey: async () => {
        throw new Error('provider_master_key_missing sensitive internal detail');
      },
      fetchImpl: async () => {
        providerCalls += 1;
        throw new Error('must not reach Stripe');
      },
    });
    const binding = new RuntimeHostedGatewayBinding({
      ctx: { storage: store },
      resolveRegistration: resolver,
    });

    const response = await handleHostedGatewayInternalRequest({
      binding,
      request: new Request(`https://q18.internal${INTERNAL_HOSTED_EXECUTE_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${rawKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          operation_id: 'refund:credential-failure',
          target: { provider: 'stripe', action: 'refund.create' },
          payload: { payment_intent: 'pi_credentialfailure123', amount: 100 },
        }),
      }),
    });

    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, /provider_credentials_unavailable/);
    assert.doesNotMatch(text, /provider_master_key_missing|sensitive internal detail/);
    assert.equal(providerCalls, 0);
    assert.equal(
      store.sql.exec('SELECT COUNT(*) AS n FROM hosted_gateway_operations')[0].n,
      0,
    );
  } finally {
    store.db.close();
  }
});

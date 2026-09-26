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

function createContext(store) {
  return { storage: store };
}

async function seedApiKey(store, rawKey, tenantId, keyId = `key_${tenantId}`) {
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
    `
      INSERT INTO api_keys (key_id, key_hash, customer_id, created_at, revoked_at)
      VALUES (?, ?, ?, ?, NULL)
    `,
    keyId,
    await sha256Hex(rawKey),
    tenantId,
    new Date().toISOString(),
  );
}

function refundBody(operationId, paymentIntent = 'pi_hostedproof123', amount = 100) {
  return {
    operation_id: operationId,
    target: {
      provider: 'stripe',
      action: 'refund.create',
    },
    payload: {
      payment_intent: paymentIntent,
      amount,
    },
  };
}

function request(key, requestBody) {
  return new Request(`https://q18.internal${INTERNAL_HOSTED_EXECUTE_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
}

async function dispatch(binding, key, requestBody) {
  return handleHostedGatewayInternalRequest({
    request: request(key, requestBody),
    binding,
  });
}

function createFakeStripe({ loseFirstAcknowledgement = false } = {}) {
  const refunds = [];
  const byIdempotencyKey = new Map();
  const postKeys = [];
  let postCalls = 0;
  let getCalls = 0;
  let lost = false;

  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') {
      postCalls += 1;
      const key = init.headers['idempotency-key'];
      postKeys.push(key);
      let refund = byIdempotencyKey.get(key);
      if (!refund) {
        const body = init.body;
        refund = {
          id: `re_hosted_${refunds.length + 1}`,
          payment_intent: body.get('payment_intent'),
          amount: Number(body.get('amount')),
          status: 'succeeded',
          metadata: {
            once_operation_id: body.get('metadata[once_operation_id]'),
            once_effect_hash: body.get('metadata[once_effect_hash]'),
          },
        };
        byIdempotencyKey.set(key, refund);
        refunds.push(refund);
      }

      if (loseFirstAcknowledgement && !lost) {
        lost = true;
        throw new Error('connection lost after Stripe committed refund');
      }

      return Response.json(refund);
    }

    if (init.method === 'GET') {
      getCalls += 1;
      const parsed = new URL(url);
      const paymentIntent = parsed.searchParams.get('payment_intent');
      return Response.json({
        data: refunds.filter((refund) => refund.payment_intent === paymentIntent),
        has_more: false,
      });
    }

    throw new Error(`unexpected Stripe method: ${init.method}`);
  };

  return {
    fetchImpl,
    refunds,
    postKeys,
    get postCalls() {
      return postCalls;
    },
    get getCalls() {
      return getCalls;
    },
  };
}

test('Stripe refund lost acknowledgement reconciles end-to-end through internal hosted HTTP', async () => {
  const store = storage();
  try {
    const rawKey = 'once_test_hosted_stripe';
    const tenantId = 'tenant_hosted_stripe';
    await seedApiKey(store, rawKey, tenantId);

    const stripe = createFakeStripe({ loseFirstAcknowledgement: true });
    const resolver = createHostedStripeRefundResolver({
      getSecretKey: async ({ tenantId: requestedTenant }) => {
        assert.equal(requestedTenant, tenantId);
        return 'sk_test_hosted_fixture';
      },
      fetchImpl: stripe.fetchImpl,
    });

    const operationId = 'refund:hosted-lost-ack';
    const body = refundBody(operationId);

    const firstBinding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: resolver,
      clock: () => '2026-09-26T20:00:00.000Z',
    });

    const first = await dispatch(firstBinding, rawKey, body);
    assert.equal(first.status, 200);
    const firstJson = await first.json();
    assert.equal(firstJson.decision, 'BLOCK_UNKNOWN');
    assert.equal(firstJson.state, 'UNKNOWN');
    assert.deepEqual(firstJson.target, { provider: 'stripe', action: 'refund.create' });
    assert.match(firstJson.effect_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(stripe.postCalls, 1);
    assert.equal(stripe.refunds.length, 1);
    assert.equal(
      store.sql.exec(
        `SELECT state FROM hosted_gateway_operations WHERE tenant_id = ?`,
        tenantId,
      )[0].state,
      'UNKNOWN',
    );

    // New binding simulates a fresh Durable Object instance with the same SQL.
    const restartedBinding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: resolver,
      clock: () => '2026-09-26T20:01:00.000Z',
    });

    const retry = await dispatch(restartedBinding, rawKey, body);
    assert.equal(retry.status, 200);
    const retryJson = await retry.json();
    assert.equal(retryJson.decision, 'REPLAY_CONFIRMED');
    assert.equal(retryJson.state, 'CONFIRMED');
    assert.equal(retryJson.result.refundId, 're_hosted_1');

    const replay = await dispatch(restartedBinding, rawKey, body);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).decision, 'REPLAY_CONFIRMED');

    assert.equal(stripe.postCalls, 1);
    assert.equal(stripe.refunds.length, 1);
    assert.equal(stripe.getCalls, 1);
    assert.equal(stripe.postKeys.length, 1);
    assert.match(stripe.postKeys[0], /^once_hv1_[a-f0-9]{64}$/);
    assert.doesNotMatch(stripe.postKeys[0], /tenant_hosted_stripe|refund:hosted-lost-ack/);
    assert.equal(stripe.refunds[0].metadata.once_operation_id, operationId);
    assert.equal(stripe.refunds[0].metadata.once_effect_hash, firstJson.effect_hash);
    assert.equal(
      store.sql.exec(
        `SELECT state FROM hosted_gateway_operations WHERE tenant_id = ?`,
        tenantId,
      )[0].state,
      'CONFIRMED',
    );
  } finally {
    store.db.close();
  }
});

test('same operation ID in two tenants derives different Stripe idempotency keys', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_stripe_a', 'tenant_stripe_a');
    await seedApiKey(store, 'once_test_stripe_b', 'tenant_stripe_b');

    const stripe = createFakeStripe();
    const resolver = createHostedStripeRefundResolver({
      getSecretKey: async ({ tenantId }) => `sk_test_${tenantId}`,
      fetchImpl: stripe.fetchImpl,
    });
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: resolver,
    });
    const shared = refundBody('refund:shared-across-tenants', 'pi_shared123', 200);

    const a = await dispatch(binding, 'once_test_stripe_a', shared);
    const b = await dispatch(binding, 'once_test_stripe_b', shared);

    assert.equal((await a.json()).decision, 'EXECUTE');
    assert.equal((await b.json()).decision, 'EXECUTE');
    assert.equal(stripe.postCalls, 2);
    assert.equal(stripe.postKeys.length, 2);
    assert.notEqual(stripe.postKeys[0], stripe.postKeys[1]);
    assert.match(stripe.postKeys[0], /^once_hv1_[a-f0-9]{64}$/);
    assert.match(stripe.postKeys[1], /^once_hv1_[a-f0-9]{64}$/);
  } finally {
    store.db.close();
  }
});

test('live-looking Stripe credential is rejected before durable UNKNOWN is written', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_live_reject', 'tenant_live_reject');
    let providerCalls = 0;
    const resolver = createHostedStripeRefundResolver({
      getSecretKey: async () => 'sk_live_must_never_run',
      fetchImpl: async () => {
        providerCalls += 1;
        throw new Error('must not call Stripe');
      },
    });
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: resolver,
    });

    const response = await dispatch(
      binding,
      'once_test_live_reject',
      refundBody('refund:reject-live', 'pi_reject123', 100),
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'stripe_test_credentials_required');
    assert.equal(providerCalls, 0);
    assert.equal(
      store.sql.exec('SELECT COUNT(*) AS n FROM hosted_gateway_operations')[0].n,
      0,
    );
  } finally {
    store.db.close();
  }
});

test('Stripe refund schema rejects non-effect fields before provider access or durable state', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_stripe_schema', 'tenant_stripe_schema');
    let secretLookups = 0;
    const resolver = createHostedStripeRefundResolver({
      getSecretKey: async () => {
        secretLookups += 1;
        return 'sk_test_unused';
      },
      fetchImpl: async () => {
        throw new Error('must not call Stripe');
      },
    });
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: resolver,
    });

    const invalid = refundBody('refund:invalid-schema', 'pi_invalid123', 100);
    invalid.payload.currency = 'gbp';
    const response = await dispatch(binding, 'once_test_stripe_schema', invalid);

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_refund_payload');
    assert.equal(secretLookups, 0);
    assert.equal(
      store.sql.exec('SELECT COUNT(*) AS n FROM hosted_gateway_operations')[0].n,
      0,
    );
  } finally {
    store.db.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GatewayCore,
  GatewayDecision,
  MemoryOperationStore,
} from '../src/gateway-core.js';
import { StripeRefundAdapter } from '../src/stripe-refund-adapter.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('adapter rejects non-test Stripe secrets', () => {
  assert.throws(
    () => new StripeRefundAdapter({ secretKey: 'sk_live_example' }),
    /sandbox\/test secret key/,
  );
});

test('execute creates a refund bound to logical identity and effect hash', async () => {
  let captured;
  const adapter = new StripeRefundAdapter({
    secretKey: 'sk_test_example',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse({
        id: 're_123',
        payment_intent: 'pi_123',
        amount: 1900,
        status: 'succeeded',
      });
    },
  });

  const result = await adapter.execute({
    operationId: 'refund:order-123',
    effectHash: 'stripe-refund:pi_123:1900',
    payload: { paymentIntent: 'pi_123', amount: 1900 },
  });

  assert.equal(captured.url, 'https://api.stripe.com/v1/refunds');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['idempotency-key'], 'once:refund:order-123');
  assert.equal(captured.init.body.get('payment_intent'), 'pi_123');
  assert.equal(captured.init.body.get('amount'), '1900');
  assert.equal(captured.init.body.get('metadata[once_operation_id]'), 'refund:order-123');
  assert.equal(captured.init.body.get('metadata[once_effect_hash]'), 'stripe-refund:pi_123:1900');
  assert.equal(result.providerReference, 're_123');
});

test('transport failure after refund dispatch is treated as ambiguous', async () => {
  const adapter = new StripeRefundAdapter({
    secretKey: 'sk_test_example',
    fetchImpl: async () => {
      throw new Error('socket reset');
    },
  });

  await assert.rejects(
    adapter.execute({
      operationId: 'refund:transport',
      effectHash: 'stripe-refund:pi_transport:500',
      payload: { paymentIntent: 'pi_transport', amount: 500 },
    }),
    (error) => error?.name === 'AmbiguousOutcomeError',
  );
});

test('reconcile confirms only a refund matching operation, effect and payload', async () => {
  let capturedUrl;
  const adapter = new StripeRefundAdapter({
    secretKey: 'sk_test_example',
    fetchImpl: async (url) => {
      capturedUrl = url;
      return jsonResponse({
        data: [
          {
            id: 're_wrong_effect',
            payment_intent: 'pi_match',
            amount: 700,
            status: 'succeeded',
            metadata: {
              once_operation_id: 'refund:match',
              once_effect_hash: 'stripe-refund:pi_match:999',
            },
          },
          {
            id: 're_match',
            payment_intent: 'pi_match',
            amount: 700,
            status: 'succeeded',
            metadata: {
              once_operation_id: 'refund:match',
              once_effect_hash: 'stripe-refund:pi_match:700',
            },
          },
        ],
      });
    },
  });

  const result = await adapter.reconcile({
    operationId: 'refund:match',
    effectHash: 'stripe-refund:pi_match:700',
    payload: { paymentIntent: 'pi_match', amount: 700 },
  });

  const url = new URL(capturedUrl);
  assert.equal(url.searchParams.get('payment_intent'), 'pi_match');
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.providerReference, 're_match');
});

test('missing refund evidence remains UNKNOWN and never asserts ABSENT', async () => {
  const adapter = new StripeRefundAdapter({
    secretKey: 'sk_test_example',
    fetchImpl: async () => jsonResponse({ data: [], has_more: false }),
  });

  const result = await adapter.reconcile({
    operationId: 'refund:missing',
    effectHash: 'stripe-refund:pi_missing:700',
    payload: { paymentIntent: 'pi_missing', amount: 700 },
  });

  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.authoritative, false);
});

test('operation identity is bounded for Stripe idempotency safety', async () => {
  const adapter = new StripeRefundAdapter({ secretKey: 'sk_test_example' });
  const operationId = `refund:${'x'.repeat(240)}`;

  await assert.rejects(
    adapter.execute({
      operationId,
      effectHash: 'hash',
      payload: { paymentIntent: 'pi_long', amount: 100 },
    }),
    /operationId must be <= 240 characters/,
  );
});

test('lost acknowledgement then retry reconciles to one Stripe refund effect', async () => {
  const providerRefunds = [];
  const providerIdempotency = new Map();
  let postCalls = 0;

  const adapter = new StripeRefundAdapter({
    secretKey: 'sk_test_example',
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'POST') {
        postCalls += 1;
        const body = init.body;
        const idempotencyKey = init.headers['idempotency-key'];

        if (!providerIdempotency.has(idempotencyKey)) {
          const refund = {
            id: `re_${providerRefunds.length + 1}`,
            payment_intent: body.get('payment_intent'),
            amount: Number(body.get('amount')),
            status: 'succeeded',
            metadata: {
              once_operation_id: body.get('metadata[once_operation_id]'),
              once_effect_hash: body.get('metadata[once_effect_hash]'),
            },
          };
          providerIdempotency.set(idempotencyKey, refund);
          providerRefunds.push(refund);
        }

        // Simulate provider commit followed by lost acknowledgement.
        throw new Error('connection lost after provider commit');
      }

      const requestUrl = new URL(url);
      const paymentIntent = requestUrl.searchParams.get('payment_intent');
      return jsonResponse({
        data: providerRefunds.filter((refund) => refund.payment_intent === paymentIntent),
        has_more: false,
      });
    },
  });

  const gateway = new GatewayCore({
    store: new MemoryOperationStore(),
    clock: () => '2026-09-26T00:00:00.000Z',
  });

  const request = {
    operationId: 'refund:lost-ack-proof',
    effectHash: 'stripe-refund:pi_proof:900',
    payload: { paymentIntent: 'pi_proof', amount: 900 },
  };

  const first = await gateway.execute(request, adapter);
  const retry = await gateway.execute(request, adapter);
  const replay = await gateway.execute(request, adapter);

  assert.equal(first.decision, GatewayDecision.BLOCK_UNKNOWN);
  assert.equal(retry.decision, GatewayDecision.REPLAY_CONFIRMED);
  assert.equal(replay.decision, GatewayDecision.REPLAY_CONFIRMED);
  assert.equal(postCalls, 1);
  assert.equal(providerRefunds.length, 1);
  assert.equal(retry.result.refundId, 're_1');
});

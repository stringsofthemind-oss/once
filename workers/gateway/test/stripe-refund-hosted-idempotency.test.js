import test from 'node:test';
import assert from 'node:assert/strict';

import { StripeRefundAdapter } from '../src/stripe-refund-adapter.js';

test('hosted provider operation key overrides raw logical id for Stripe idempotency namespace', async () => {
  let captured;
  const adapter = new StripeRefundAdapter({
    secretKey: 'sk_test_example',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({
        id: 're_hosted',
        payment_intent: 'pi_hosted',
        amount: 100,
        status: 'succeeded',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await adapter.execute({
    operationId: 'refund:same-logical-id',
    effectHash: 'sha256:hosted',
    payload: { paymentIntent: 'pi_hosted', amount: 100 },
    metadata: {
      hosted: {
        providerOperationKey: `once_hv1_${'a'.repeat(64)}`,
      },
    },
  });

  assert.equal(captured.init.headers['idempotency-key'], `once_hv1_${'a'.repeat(64)}`);
  assert.notEqual(captured.init.headers['idempotency-key'], 'once:refund:same-logical-id');
});

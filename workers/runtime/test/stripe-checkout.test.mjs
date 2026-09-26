import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ONCE_CHECKOUT_CANCEL_URL,
  ONCE_CHECKOUT_SUCCESS_URL,
  ONCE_DEVELOPER_PRICE_ID,
  buildCheckoutSessionBody,
  handleStripeCheckout,
} from '../src/stripe-checkout.js';

test('buildCheckoutSessionBody uses the configured recurring Developer price', () => {
  const body = buildCheckoutSessionBody();

  assert.equal(body.get('mode'), 'subscription');
  assert.equal(body.get('ui_mode'), 'hosted_page');
  assert.equal(body.get('success_url'), ONCE_CHECKOUT_SUCCESS_URL);
  assert.equal(body.get('cancel_url'), ONCE_CHECKOUT_CANCEL_URL);
  assert.equal(body.get('line_items[0][price]'), ONCE_DEVELOPER_PRICE_ID);
  assert.equal(body.get('line_items[0][quantity]'), '1');
  assert.equal(body.get('billing_address_collection'), 'auto');
  assert.equal(body.get('phone_number_collection[enabled]'), 'false');
  assert.equal(body.get('automatic_tax[enabled]'), 'false');
  assert.equal(body.get('allow_promotion_codes'), 'false');
  assert.equal(body.get('payment_method_collection'), 'always');
  assert.equal(body.get('submit_type'), 'auto');
  assert.equal(body.get('integration_identifier'), 'hosted_web_0001');
  assert.equal(body.get('origin_context'), 'web');
});

test('checkout fails closed when Stripe secret is not configured', async () => {
  const response = await handleStripeCheckout(
    new Request('https://runtime.test/v1/billing/checkout', { method: 'POST' }),
    {},
    async () => {
      throw new Error('fetch must not run');
    },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'stripe_not_configured' });
});

test('checkout posts the configured body to Stripe and returns only id and url', async () => {
  let captured;
  const response = await handleStripeCheckout(
    new Request('https://runtime.test/v1/billing/checkout', { method: 'POST' }),
    { STRIPE_SECRET_KEY: 'sk_test_example' },
    async (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          id: 'cs_test_123',
          url: 'https://checkout.stripe.com/c/pay/cs_test_123',
          customer: 'cus_should_not_leak',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );

  assert.equal(captured.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.authorization, 'Bearer sk_test_example');
  assert.equal(captured.init.body.get('mode'), 'subscription');
  assert.equal(captured.init.body.get('line_items[0][price]'), ONCE_DEVELOPER_PRICE_ID);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: 'cs_test_123',
    url: 'https://checkout.stripe.com/c/pay/cs_test_123',
  });
});

test('checkout does not expose Stripe error messages or request details', async () => {
  const response = await handleStripeCheckout(
    new Request('https://runtime.test/v1/billing/checkout', { method: 'POST' }),
    { STRIPE_SECRET_KEY: 'sk_test_example' },
    async () => new Response(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          code: 'resource_missing',
          message: 'sensitive provider detail',
        },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: 'stripe_checkout_failed',
    stripe_type: 'invalid_request_error',
    stripe_code: 'resource_missing',
  });
});

const STRIPE_CHECKOUT_ENDPOINT = 'https://api.stripe.com/v1/checkout/sessions';

export const ONCE_DEVELOPER_PRICE_ID = 'price_1UJyvzAHX5spO4zqEefb2D3I';
export const ONCE_CHECKOUT_SUCCESS_URL = 'https://onceexec.com/success?session_id={CHECKOUT_SESSION_ID}';
export const ONCE_CHECKOUT_CANCEL_URL = 'https://onceexec.com/';

function checkoutHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: checkoutHeaders(origin),
  });
}

export function buildCheckoutSessionBody({
  priceId = ONCE_DEVELOPER_PRICE_ID,
  successUrl = ONCE_CHECKOUT_SUCCESS_URL,
  cancelUrl = ONCE_CHECKOUT_CANCEL_URL,
} = {}) {
  const body = new URLSearchParams();
  body.set('mode', 'subscription');
  body.set('ui_mode', 'hosted_page');
  body.set('success_url', successUrl);
  body.set('cancel_url', cancelUrl);
  body.set('line_items[0][price]', priceId);
  body.set('line_items[0][quantity]', '1');
  body.set('billing_address_collection', 'auto');
  body.set('phone_number_collection[enabled]', 'false');
  body.set('automatic_tax[enabled]', 'false');
  body.set('allow_promotion_codes', 'false');
  body.set('payment_method_collection', 'always');
  body.set('submit_type', 'auto');
  body.set('integration_identifier', 'hosted_web_0001');
  body.set('origin_context', 'web');
  return body;
}

export async function handleStripeCheckout(request, env, fetchImpl = fetch) {
  const allowedOrigin = env.CHECKOUT_ALLOWED_ORIGIN || 'https://onceexec.com';

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: checkoutHeaders(allowedOrigin),
    });
  }

  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, allowedOrigin);
  }

  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'stripe_not_configured' }, 503, allowedOrigin);
  }

  const response = await fetchImpl(STRIPE_CHECKOUT_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: buildCheckoutSessionBody(),
  });

  let data;
  try {
    data = await response.json();
  } catch {
    return json({ error: 'stripe_invalid_response' }, 502, allowedOrigin);
  }

  if (!response.ok) {
    return json(
      {
        error: 'stripe_checkout_failed',
        stripe_type: data?.error?.type ?? null,
        stripe_code: data?.error?.code ?? null,
      },
      502,
      allowedOrigin,
    );
  }

  if (typeof data?.id !== 'string' || typeof data?.url !== 'string') {
    return json({ error: 'stripe_checkout_response_incomplete' }, 502, allowedOrigin);
  }

  return json({ id: data.id, url: data.url }, 200, allowedOrigin);
}

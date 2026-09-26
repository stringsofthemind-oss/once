import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import {
  GatewayCore,
  GatewayDecision,
  MemoryOperationStore,
} from '../src/gateway-core.js';
import { StripeRefundAdapter } from '../src/stripe-refund-adapter.js';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const secretKey = process.env.STRIPE_SECRET_KEY;

if (typeof secretKey !== 'string' || !secretKey.startsWith('sk_test_')) {
  throw new Error('STRIPE_SECRET_KEY must be a Stripe sandbox/test secret beginning with sk_test_.');
}

const amount = Number.parseInt(process.env.STRIPE_PROOF_AMOUNT ?? '100', 10);
if (!Number.isSafeInteger(amount) || amount < 50) {
  throw new Error('STRIPE_PROOF_AMOUNT must be an integer >= 50 (minor currency units).');
}

const currency = 'gbp';
const runId = `phase12b-${Date.now()}-${randomUUID().slice(0, 8)}`;

function authHeaders(contentType = false) {
  const headers = { authorization: `Bearer ${secretKey}` };
  if (contentType) headers['content-type'] = 'application/x-www-form-urlencoded';
  return headers;
}

async function parseStripeResponse(response, label) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`${label}: Stripe returned a non-JSON response`);
  }

  if (!response.ok) {
    const type = data?.error?.type ?? 'unknown';
    const code = data?.error?.code ?? 'unknown';
    throw new Error(`${label}: Stripe request failed (${type}/${code}, HTTP ${response.status})`);
  }

  return data;
}

async function createSucceededPaymentIntent() {
  const body = new URLSearchParams();
  body.set('amount', String(amount));
  body.set('currency', currency);
  body.set('payment_method', 'pm_card_visa');
  body.set('confirm', 'true');
  body.append('payment_method_types[]', 'card');
  body.set('metadata[once_phase]', '12b');
  body.set('metadata[once_proof_run]', runId);

  const response = await fetch(`${STRIPE_API_BASE}/payment_intents`, {
    method: 'POST',
    headers: authHeaders(true),
    body,
  });

  const paymentIntent = await parseStripeResponse(response, 'create PaymentIntent');
  assert.equal(paymentIntent.livemode, false, 'PaymentIntent must be test-mode only');
  assert.equal(paymentIntent.status, 'succeeded', `expected succeeded PaymentIntent, got ${paymentIntent.status}`);
  return paymentIntent;
}

async function listMatchingRefunds({ paymentIntentId, operationId, effectHash }) {
  const query = new URLSearchParams();
  query.set('limit', '100');
  query.set('payment_intent', paymentIntentId);

  const response = await fetch(`${STRIPE_API_BASE}/refunds?${query}`, {
    method: 'GET',
    headers: authHeaders(false),
  });
  const data = await parseStripeResponse(response, 'list refunds');

  if (!Array.isArray(data?.data)) throw new Error('list refunds: malformed Stripe response');

  return data.data.filter((refund) => (
    refund?.payment_intent === paymentIntentId
    && refund?.amount === amount
    && refund?.metadata?.once_operation_id === operationId
    && refund?.metadata?.once_effect_hash === effectHash
  ));
}

const paymentIntent = await createSucceededPaymentIntent();
const operationId = `refund:${runId}`;
const effectHash = createHash('sha256')
  .update(JSON.stringify({
    kind: 'stripe_refund',
    paymentIntent: paymentIntent.id,
    amount,
    currency,
  }))
  .digest('hex');

let refundPostCalls = 0;
let injectedLostAcknowledgements = 0;

const faultInjectingFetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';

  if (method === 'POST' && url === `${STRIPE_API_BASE}/refunds`) {
    refundPostCalls += 1;
    const response = await fetch(url, init);

    if (!response.ok) {
      return response;
    }

    // Stripe has committed and returned success. Deliberately consume and discard
    // that successful acknowledgement, then surface a transport-style failure to
    // the adapter. The next logical retry must reconcile provider truth instead of
    // issuing a second refund.
    await response.arrayBuffer();
    injectedLostAcknowledgements += 1;
    throw new Error('Injected lost acknowledgement after successful Stripe refund commit');
  }

  return fetch(url, init);
};

const adapter = new StripeRefundAdapter({
  secretKey,
  fetchImpl: faultInjectingFetch,
});

const gateway = new GatewayCore({
  store: new MemoryOperationStore(),
  clock: () => new Date().toISOString(),
});

const request = {
  operationId,
  effectHash,
  payload: {
    paymentIntent: paymentIntent.id,
    amount,
  },
};

const first = await gateway.execute(request, adapter);
const retry = await gateway.execute(request, adapter);
const replay = await gateway.execute(request, adapter);
const matchingRefunds = await listMatchingRefunds({
  paymentIntentId: paymentIntent.id,
  operationId,
  effectHash,
});

assert.equal(first.decision, GatewayDecision.BLOCK_UNKNOWN);
assert.equal(retry.decision, GatewayDecision.REPLAY_CONFIRMED);
assert.equal(replay.decision, GatewayDecision.REPLAY_CONFIRMED);
assert.equal(refundPostCalls, 1, 'exactly one refund POST should cross the provider boundary');
assert.equal(injectedLostAcknowledgements, 1, 'exactly one successful acknowledgement should be dropped');
assert.equal(matchingRefunds.length, 1, 'Stripe should contain exactly one matching refund effect');
assert.equal(retry.result.refundId, matchingRefunds[0].id);

const evidence = {
  proof: 'ONCE_PHASE_12B_STRIPE_SANDBOX_LOST_ACK',
  passed: true,
  livemode: false,
  run_id: runId,
  payment_intent: paymentIntent.id,
  refund_id: matchingRefunds[0].id,
  amount,
  currency,
  operation_id: operationId,
  effect_hash: effectHash,
  first_decision: first.decision,
  retry_decision: retry.decision,
  replay_decision: replay.decision,
  refund_post_calls: refundPostCalls,
  matching_provider_refunds: matchingRefunds.length,
  injected_lost_acknowledgements: injectedLostAcknowledgements,
};

console.log(JSON.stringify(evidence, null, 2));

import { AmbiguousOutcomeError } from './gateway-core.js';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function buildRefundBody({ paymentIntent, amount, operationId }) {
  requireString(paymentIntent, 'payload.paymentIntent');
  requireString(operationId, 'operationId');

  const body = new URLSearchParams();
  body.set('payment_intent', paymentIntent);
  if (amount !== undefined) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new TypeError('payload.amount must be a positive integer when provided');
    }
    body.set('amount', String(amount));
  }
  body.set('metadata[once_operation_id]', operationId);
  return body;
}

function summarizeRefund(refund) {
  if (!refund || typeof refund !== 'object' || typeof refund.id !== 'string') {
    throw new TypeError('Stripe refund response is incomplete');
  }

  return {
    providerReference: refund.id,
    refundId: refund.id,
    paymentIntent: refund.payment_intent ?? null,
    amount: Number.isSafeInteger(refund.amount) ? refund.amount : null,
    status: typeof refund.status === 'string' ? refund.status : null,
  };
}

export class StripeRefundAdapter {
  constructor({ secretKey, fetchImpl = fetch, apiBase = STRIPE_API_BASE }) {
    requireString(secretKey, 'secretKey');
    if (!secretKey.startsWith('sk_test_')) {
      throw new Error('Phase 12B Stripe refund adapter requires a sandbox/test secret key');
    }
    this.secretKey = secretKey;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  headers() {
    return {
      authorization: `Bearer ${this.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    };
  }

  async execute({ operationId, payload }) {
    const response = await this.fetchImpl(`${this.apiBase}/refunds`, {
      method: 'POST',
      headers: this.headers(),
      body: buildRefundBody({ ...payload, operationId }),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      throw new AmbiguousOutcomeError('Stripe refund response could not be decoded');
    }

    if (!response.ok) {
      const type = data?.error?.type;
      const code = data?.error?.code;

      if (type === 'api_connection_error' || type === 'api_error' || response.status >= 500) {
        throw new AmbiguousOutcomeError('Stripe refund outcome is ambiguous');
      }

      const error = new Error('Stripe refund request failed deterministically');
      error.name = 'StripeRefundError';
      error.stripeType = type ?? null;
      error.stripeCode = code ?? null;
      throw error;
    }

    return summarizeRefund(data);
  }

  async reconcile({ operationId }) {
    requireString(operationId, 'operationId');

    const query = new URLSearchParams();
    query.set('limit', '100');

    const response = await this.fetchImpl(`${this.apiBase}/refunds?${query.toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.secretKey}` },
    });

    if (!response.ok) {
      return { status: 'UNKNOWN' };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { status: 'UNKNOWN' };
    }

    if (!Array.isArray(data?.data)) {
      return { status: 'UNKNOWN' };
    }

    const match = data.data.find((refund) => refund?.metadata?.once_operation_id === operationId);
    if (match) {
      const result = summarizeRefund(match);
      return {
        status: 'CONFIRMED',
        authoritative: true,
        providerReference: result.providerReference,
        result,
      };
    }

    return {
      status: 'UNKNOWN',
      authoritative: false,
      reason: 'provider_listing_did_not_prove_absence',
    };
  }
}

import { HostedGatewayError } from '../../gateway/src/hosted-gateway-core.js';
import { StripeRefundAdapter } from '../../gateway/src/stripe-refund-adapter.js';

export const HOSTED_STRIPE_PROVIDER = 'stripe';
export const HOSTED_STRIPE_REFUND_ACTION = 'refund.create';
export const HOSTED_STRIPE_REFUND_BINDING_VERSION = 'stripe-refund-v1';

function requireRefundPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HostedGatewayError('invalid_refund_payload', 400);
  }

  const keys = Object.keys(payload).sort();
  const allowed = new Set(['amount', 'payment_intent']);
  if (keys.some((key) => !allowed.has(key))) {
    throw new HostedGatewayError('invalid_refund_payload', 400);
  }

  const paymentIntent = payload.payment_intent;
  if (typeof paymentIntent !== 'string' || !/^pi_[A-Za-z0-9]+$/.test(paymentIntent)) {
    throw new HostedGatewayError('invalid_refund_payload', 400);
  }

  if (
    payload.amount !== undefined &&
    (!Number.isSafeInteger(payload.amount) || payload.amount <= 0)
  ) {
    throw new HostedGatewayError('invalid_refund_payload', 400);
  }

  return {
    paymentIntent,
    ...(payload.amount !== undefined ? { amount: payload.amount } : {}),
  };
}

function adapterPayload(payload) {
  const normalized = requireRefundPayload(payload);
  return {
    paymentIntent: normalized.paymentIntent,
    ...(normalized.amount !== undefined ? { amount: normalized.amount } : {}),
  };
}

/**
 * Creates the one Phase 12C V1 provider registration currently allowed behind
 * the internal hosted transport: Stripe test-mode refund creation.
 *
 * getSecretKey is intentionally injected and tenant-aware. This module does not
 * read a global environment secret, so future staging wiring cannot silently
 * turn one Stripe credential into a cross-tenant credential store.
 */
export function createHostedStripeRefundResolver({
  getSecretKey,
  fetchImpl = fetch,
  apiBase,
} = {}) {
  if (typeof getSecretKey !== 'function') {
    throw new TypeError('getSecretKey must be a function');
  }

  return async ({ tenantId, provider, action }) => {
    if (provider !== HOSTED_STRIPE_PROVIDER || action !== HOSTED_STRIPE_REFUND_ACTION) {
      return null;
    }

    return {
      protection: 'PROTECT',
      bindingVersion: HOSTED_STRIPE_REFUND_BINDING_VERSION,

      canonicalizeEffect(payload) {
        const normalized = requireRefundPayload(payload);
        return {
          payment_intent: normalized.paymentIntent,
          ...(normalized.amount !== undefined ? { amount: normalized.amount } : {}),
        };
      },

      async createAdapter(context) {
        let secretKey;
        try {
          secretKey = await getSecretKey({
            tenantId,
            provider,
            action,
            providerOperationKey: context.providerOperationKey,
          });
        } catch {
          // Credential-store corruption, missing master-key material or a
          // decryption failure is deterministic infrastructure failure, not
          // evidence about provider state. Keep the detail server-side and fail
          // before GatewayCore records a new UNKNOWN boundary.
          throw new HostedGatewayError('provider_credentials_unavailable', 503);
        }

        if (typeof secretKey !== 'string' || secretKey.length === 0) {
          throw new HostedGatewayError('provider_credentials_unavailable', 503);
        }
        if (!secretKey.startsWith('sk_test_')) {
          throw new HostedGatewayError('stripe_test_credentials_required', 503);
        }

        const stripe = new StripeRefundAdapter({
          secretKey,
          fetchImpl,
          ...(apiBase ? { apiBase } : {}),
        });

        return {
          execute(input) {
            return stripe.execute({
              ...input,
              payload: adapterPayload(input.payload),
            });
          },
          reconcile(input) {
            return stripe.reconcile({
              ...input,
              payload: adapterPayload(input.payload),
            });
          },
        };
      },
    };
  };
}

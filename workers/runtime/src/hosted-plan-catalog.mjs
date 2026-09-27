export const ONCE_DEVELOPER_SANDBOX_PRICE_ID = 'price_1UJyvzAHX5spO4zqEefb2D3I';

export const HOSTED_STRIPE_PRICE_PLAN_MAP = Object.freeze({
  // Current sandbox checkout price. Commercial usage limits are deliberately
  // not assigned in Phase 12D, so admission will fail closed until approved.
  [ONCE_DEVELOPER_SANDBOX_PRICE_ID]: 'developer',

  // Legacy sandbox catalogue retained only for migration compatibility with
  // existing entitlement rows and pre-Phase-12D subscriptions.
  price_1UGqPRAHX5spO4zqQcuRzi3S: 'pro',
  price_1UGqPWAHX5spO4zqWlFeMbwO: 'startup',
  price_1UGqPfAHX5spO4zqKaLaAINp: 'scale',
});

export const LEGACY_HOSTED_PLAN_LIMITS = Object.freeze({
  pro: 100_000,
  startup: 500_000,
  scale: 2_000_000,
});

/**
 * Resolve entitlement identity from Stripe billing truth.
 *
 * The Stripe price id is authoritative. Subscription metadata is deliberately
 * diagnostic only: it cannot promote an unknown price into an entitled plan or
 * override a known price mapping. This closes a control-plane path where
 * caller-controlled/stale metadata could otherwise outrank the purchased price.
 */
export function resolveHostedStripePlan({ priceId, metadataPlan = null } = {}) {
  const normalizedPriceId = String(priceId || '').trim();
  const normalizedMetadataPlan = String(metadataPlan || '').trim().toLowerCase() || null;
  const plan = HOSTED_STRIPE_PRICE_PLAN_MAP[normalizedPriceId] || 'unknown';

  return Object.freeze({
    priceId: normalizedPriceId || null,
    plan,
    knownPrice: plan !== 'unknown',
    metadataPlan: normalizedMetadataPlan,
    metadataMatches:
      normalizedMetadataPlan === null || plan === 'unknown'
        ? null
        : normalizedMetadataPlan === plan,
  });
}

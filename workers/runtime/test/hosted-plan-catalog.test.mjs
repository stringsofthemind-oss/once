import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOSTED_STRIPE_PRICE_PLAN_MAP,
  LEGACY_HOSTED_PLAN_LIMITS,
  ONCE_DEVELOPER_SANDBOX_PRICE_ID,
  resolveHostedStripePlan,
} from '../src/hosted-plan-catalog.mjs';
import { ONCE_DEVELOPER_PRICE_ID } from '../src/stripe-checkout.js';

test('current sandbox checkout price is sourced from the shared hosted plan catalogue', () => {
  assert.equal(ONCE_DEVELOPER_PRICE_ID, ONCE_DEVELOPER_SANDBOX_PRICE_ID);
  assert.equal(HOSTED_STRIPE_PRICE_PLAN_MAP[ONCE_DEVELOPER_PRICE_ID], 'developer');
});

test('known Stripe price id outranks conflicting subscription metadata', () => {
  const resolved = resolveHostedStripePlan({
    priceId: 'price_1UGqPRAHX5spO4zqQcuRzi3S',
    metadataPlan: 'scale',
  });

  assert.equal(resolved.plan, 'pro');
  assert.equal(resolved.knownPrice, true);
  assert.equal(resolved.metadataPlan, 'scale');
  assert.equal(resolved.metadataMatches, false);
});

test('unknown Stripe price cannot be promoted by metadata', () => {
  const resolved = resolveHostedStripePlan({
    priceId: 'price_unknown_fixture',
    metadataPlan: 'scale',
  });

  assert.equal(resolved.plan, 'unknown');
  assert.equal(resolved.knownPrice, false);
  assert.equal(resolved.metadataPlan, 'scale');
  assert.equal(resolved.metadataMatches, null);
});

test('missing Stripe price remains unknown even with legacy-looking metadata', () => {
  const resolved = resolveHostedStripePlan({ metadataPlan: 'pro' });

  assert.equal(resolved.priceId, null);
  assert.equal(resolved.plan, 'unknown');
  assert.equal(resolved.knownPrice, false);
});

test('legacy hosted limits remain migration-only and do not silently assign Developer limits', () => {
  assert.deepEqual(LEGACY_HOSTED_PLAN_LIMITS, {
    pro: 100_000,
    startup: 500_000,
    scale: 2_000_000,
  });
  assert.equal(Object.hasOwn(LEGACY_HOSTED_PLAN_LIMITS, 'developer'), false);
  assert.equal(Object.hasOwn(LEGACY_HOSTED_PLAN_LIMITS, 'team'), false);
  assert.equal(Object.hasOwn(LEGACY_HOSTED_PLAN_LIMITS, 'enterprise'), false);
});

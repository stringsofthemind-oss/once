import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOSTED_STRIPE_PRICE_PLAN_MAP,
  LEGACY_HOSTED_PLAN_LIMITS,
  ONCE_DEVELOPER_SANDBOX_PRICE_ID,
  resolveHostedStripePlan,
} from '../src/hosted-plan-catalog.mjs';
import { RuntimeHostedAdmissionPolicy } from '../src/hosted-admission-policy.mjs';
import {
  INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH,
  handleHostedStripeEntitlementEvent,
} from '../src/hosted-stripe-entitlement-ordering.mjs';
import { ONCE_DEVELOPER_PRICE_ID } from '../src/stripe-checkout.js';
import { storage } from './harness.mjs';

const EVENT_CREATED = Math.floor(Date.parse('2026-09-27T02:00:00.000Z') / 1000);

function ensureEntitlements(store) {
  store.sql.exec(`
    CREATE TABLE IF NOT EXISTS stripe_entitlements (
      customer_id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      plan TEXT NOT NULL,
      status TEXT NOT NULL,
      price_id TEXT,
      current_period_end TEXT,
      updated_at TEXT NOT NULL
    )
  `);
}

function subscriptionEvent({ id, customer, priceId, metadataPlan }) {
  return {
    id,
    type: 'customer.subscription.updated',
    created: EVENT_CREATED,
    data: {
      object: {
        id: `sub_${customer}`,
        customer,
        status: 'active',
        current_period_end: EVENT_CREATED + 3600,
        metadata: { plan: metadataPlan },
        items: {
          data: [{ price: { id: priceId } }],
        },
      },
    },
  };
}

async function applyEntitlement(store, event) {
  return handleHostedStripeEntitlementEvent({
    request: new Request(`https://q18.internal${INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    }),
    ctx: { storage: store },
  });
}

function storedEntitlement(store, customer) {
  return store.sql.exec(
    `SELECT customer_id, plan, status, price_id FROM stripe_entitlements WHERE customer_id = ?`,
    customer,
  )[0] ?? null;
}

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

test('ordered entitlement writes the purchased legacy price plan instead of conflicting metadata', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    const response = await applyEntitlement(store, subscriptionEvent({
      id: 'evt_price_beats_metadata',
      customer: 'cus_price_beats_metadata',
      priceId: 'price_1UGqPRAHX5spO4zqQcuRzi3S',
      metadataPlan: 'scale',
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).entitlement.plan, 'pro');
    assert.deepEqual(storedEntitlement(store, 'cus_price_beats_metadata'), {
      customer_id: 'cus_price_beats_metadata',
      plan: 'pro',
      status: 'active',
      price_id: 'price_1UGqPRAHX5spO4zqQcuRzi3S',
    });
  } finally {
    store.db.close();
  }
});

test('ordered entitlement recognizes the current Developer sandbox price but does not invent a usage limit', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    const response = await applyEntitlement(store, subscriptionEvent({
      id: 'evt_developer_price',
      customer: 'cus_developer_price',
      priceId: ONCE_DEVELOPER_SANDBOX_PRICE_ID,
      metadataPlan: 'scale',
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).entitlement.plan, 'developer');
    assert.equal(storedEntitlement(store, 'cus_developer_price').plan, 'developer');

    const policy = new RuntimeHostedAdmissionPolicy({ ctx: { storage: store } });
    assert.throws(
      () => policy.getActivePlan('cus_developer_price'),
      (error) => error?.code === 'entitlement_plan_unsupported' && error?.status === 403,
    );
  } finally {
    store.db.close();
  }
});

test('ordered entitlement stores unknown for an unmapped price even when metadata names a legacy plan', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    const response = await applyEntitlement(store, subscriptionEvent({
      id: 'evt_unknown_price',
      customer: 'cus_unknown_price',
      priceId: 'price_unknown_fixture',
      metadataPlan: 'pro',
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).entitlement.plan, 'unknown');
    assert.equal(storedEntitlement(store, 'cus_unknown_price').plan, 'unknown');

    const policy = new RuntimeHostedAdmissionPolicy({ ctx: { storage: store } });
    assert.throws(
      () => policy.getActivePlan('cus_unknown_price'),
      (error) => error?.code === 'entitlement_plan_unsupported' && error?.status === 403,
    );
  } finally {
    store.db.close();
  }
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

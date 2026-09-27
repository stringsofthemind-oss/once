import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  HOSTED_ENTITLEMENT_ORDERING_ENABLE_VALUE,
  INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH,
  handleHostedStripeEntitlementEvent,
  maybeHandleHostedStripeEntitlementWebhook,
} from '../src/hosted-stripe-entitlement-ordering.mjs';
import { storage } from './harness.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const NOW_MS = Date.parse('2026-09-27T01:30:00.000Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

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

function subscriptionEvent({
  id,
  created,
  type = 'customer.subscription.updated',
  customer = 'cus_ordered',
  subscriptionId = 'sub_ordered',
  status = 'active',
  plan = 'pro',
  periodEnd = NOW_SECONDS + 3600,
} = {}) {
  return {
    id,
    type,
    created,
    data: {
      object: {
        id: subscriptionId,
        customer,
        status,
        current_period_end: periodEnd,
        metadata: { plan },
        items: { data: [] },
      },
    },
  };
}

function internalRequest(event) {
  return new Request(`https://q18.internal${INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

async function apply(store, event) {
  return handleHostedStripeEntitlementEvent({
    request: internalRequest(event),
    ctx: { storage: store },
  });
}

function entitlement(store, customer = 'cus_ordered') {
  return store.sql.exec(
    `
      SELECT customer_id, subscription_id, plan, status, current_period_end, updated_at
      FROM stripe_entitlements
      WHERE customer_id = ?
      LIMIT 1
    `,
    customer,
  )[0] ?? null;
}

async function stripeSignature(rawBody, secret, timestamp = NOW_SECONDS) {
  const encoder = new TextEncoder();
  const key = await webcrypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await webcrypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `t=${timestamp},v1=${hex}`;
}

test('older active lifecycle event cannot overwrite a newer cancellation', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    const newer = subscriptionEvent({
      id: 'evt_cancel_newer',
      created: NOW_SECONDS,
      type: 'customer.subscription.deleted',
      status: 'active',
    });
    const older = subscriptionEvent({
      id: 'evt_active_older',
      created: NOW_SECONDS - 60,
      type: 'customer.subscription.updated',
      status: 'active',
    });

    const cancelResponse = await apply(store, newer);
    assert.equal(cancelResponse.status, 200);
    assert.equal((await cancelResponse.json()).processed, true);
    assert.equal(entitlement(store).status, 'canceled');

    const staleResponse = await apply(store, older);
    const staleBody = await staleResponse.json();
    assert.equal(staleResponse.status, 200);
    assert.equal(staleBody.processed, false);
    assert.equal(staleBody.stale, true);
    assert.equal(entitlement(store).status, 'canceled');
    assert.equal(
      store.sql.exec(
        `SELECT outcome FROM hosted_entitlement_lifecycle_events WHERE event_id = ?`,
        'evt_active_older',
      )[0].outcome,
      'IGNORED_STALE_EVENT',
    );
  } finally {
    store.db.close();
  }
});

test('duplicate Stripe event is idempotent', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    const event = subscriptionEvent({ id: 'evt_duplicate', created: NOW_SECONDS });
    const first = await apply(store, event);
    assert.equal((await first.json()).processed, true);

    const second = await apply(store, event);
    const secondBody = await second.json();
    assert.equal(secondBody.duplicate, true);
    assert.equal(secondBody.outcome, 'APPLIED');
    assert.equal(
      store.sql.exec(
        `SELECT COUNT(*) AS n FROM hosted_entitlement_lifecycle_events WHERE event_id = ?`,
        'evt_duplicate',
      )[0].n,
      1,
    );
  } finally {
    store.db.close();
  }
});

test('ordered lifecycle also populates the legacy Stripe event ledger for rollback-safe dedupe', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    const event = subscriptionEvent({ id: 'evt_rollback_dedupe', created: NOW_SECONDS });
    assert.equal((await (await apply(store, event)).json()).processed, true);
    const legacyRow = store.sql.exec(
      `SELECT event_id, type FROM stripe_events WHERE event_id = ?`,
      'evt_rollback_dedupe',
    )[0];
    assert.equal(legacyRow.event_id, 'evt_rollback_dedupe');
    assert.equal(legacyRow.type, 'customer.subscription.updated');
  } finally {
    store.db.close();
  }
});

test('event already processed by the legacy webhook is a duplicate on first ordered handling', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    store.sql.exec(`
      CREATE TABLE stripe_events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        processed_at TEXT NOT NULL
      )
    `);
    store.sql.exec(
      `INSERT INTO stripe_events (event_id, type, processed_at) VALUES (?, ?, ?)`,
      'evt_legacy_duplicate',
      'customer.subscription.updated',
      '2026-09-27T01:00:00.000Z',
    );

    const response = await apply(store, subscriptionEvent({
      id: 'evt_legacy_duplicate',
      created: NOW_SECONDS,
    }));
    const body = await response.json();
    assert.equal(body.duplicate, true);
    assert.equal(body.outcome, 'LEGACY_ALREADY_PROCESSED');
    assert.equal(entitlement(store), null);
    assert.equal(
      store.sql.exec(
        `SELECT outcome FROM hosted_entitlement_lifecycle_events WHERE event_id = ?`,
        'evt_legacy_duplicate',
      )[0].outcome,
      'LEGACY_ALREADY_PROCESSED',
    );
  } finally {
    store.db.close();
  }
});

test('existing legacy entitlement is a conservative floor until a strictly newer event establishes ordering authority', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    store.sql.exec(
      `
        INSERT INTO stripe_entitlements (
          customer_id, subscription_id, plan, status, price_id, current_period_end, updated_at
        ) VALUES (?, ?, 'pro', 'canceled', NULL, NULL, ?)
      `,
      'cus_ordered',
      'sub_legacy',
      new Date(NOW_SECONDS * 1000).toISOString(),
    );

    const preBaseline = await apply(store, subscriptionEvent({
      id: 'evt_pre_baseline',
      created: NOW_SECONDS - 1,
      status: 'active',
    }));
    const preBody = await preBaseline.json();
    assert.equal(preBody.processed, false);
    assert.equal(preBody.stale, true);
    assert.equal(preBody.baseline, 'legacy_entitlement_updated_at');
    assert.equal(entitlement(store).status, 'canceled');
    assert.equal(
      store.sql.exec(`SELECT COUNT(*) AS n FROM hosted_entitlement_event_order`)[0].n,
      0,
    );

    const newer = await apply(store, subscriptionEvent({
      id: 'evt_post_baseline',
      created: NOW_SECONDS + 1,
      status: 'active',
    }));
    assert.equal((await newer.json()).processed, true);
    assert.equal(entitlement(store).status, 'active');
    assert.equal(
      store.sql.exec(
        `SELECT latest_event_id FROM hosted_entitlement_event_order WHERE customer_id = ?`,
        'cus_ordered',
      )[0].latest_event_id,
      'evt_post_baseline',
    );
  } finally {
    store.db.close();
  }
});

test('distinct lifecycle events in the same Stripe created-second fail closed as ambiguous', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    const first = subscriptionEvent({
      id: 'evt_same_second_active',
      created: NOW_SECONDS,
      status: 'active',
    });
    const second = subscriptionEvent({
      id: 'evt_same_second_cancel',
      created: NOW_SECONDS,
      type: 'customer.subscription.deleted',
    });

    assert.equal((await (await apply(store, first)).json()).processed, true);
    const conflict = await apply(store, second);
    const conflictBody = await conflict.json();
    assert.equal(conflictBody.processed, false);
    assert.equal(conflictBody.ambiguous, true);
    assert.equal(entitlement(store).status, 'lifecycle_ambiguous');
    assert.equal(
      store.sql.exec(
        `SELECT ambiguous FROM hosted_entitlement_event_order WHERE customer_id = ?`,
        'cus_ordered',
      )[0].ambiguous,
      1,
    );
  } finally {
    store.db.close();
  }
});

test('a strictly newer lifecycle event resolves prior same-second ambiguity', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    await apply(store, subscriptionEvent({ id: 'evt_amb_a', created: NOW_SECONDS }));
    await apply(store, subscriptionEvent({
      id: 'evt_amb_b',
      created: NOW_SECONDS,
      type: 'customer.subscription.deleted',
    }));
    assert.equal(entitlement(store).status, 'lifecycle_ambiguous');

    const resolved = await apply(store, subscriptionEvent({
      id: 'evt_resolve',
      created: NOW_SECONDS + 1,
      type: 'customer.subscription.updated',
      status: 'active',
    }));
    assert.equal((await resolved.json()).processed, true);
    assert.equal(entitlement(store).status, 'active');
    assert.equal(
      store.sql.exec(
        `SELECT ambiguous FROM hosted_entitlement_event_order WHERE customer_id = ?`,
        'cus_ordered',
      )[0].ambiguous,
      0,
    );
  } finally {
    store.db.close();
  }
});

test('accepted lifecycle updated_at is derived from Stripe event.created, not receipt time', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    const created = NOW_SECONDS - 120;
    await apply(store, subscriptionEvent({ id: 'evt_lifecycle_time', created }));
    assert.equal(entitlement(store).updated_at, new Date(created * 1000).toISOString());
  } finally {
    store.db.close();
  }
});

test('unsupported webhook event is durably ignored without entitlement mutation', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    const response = await apply(store, {
      id: 'evt_invoice',
      type: 'invoice.paid',
      created: NOW_SECONDS,
      data: { object: { id: 'in_123' } },
    });
    const body = await response.json();
    assert.equal(body.processed, false);
    assert.equal(entitlement(store), null);
    assert.equal(
      store.sql.exec(
        `SELECT outcome FROM hosted_entitlement_lifecycle_events WHERE event_id = ?`,
        'evt_invoice',
      )[0].outcome,
      'IGNORED_UNSUPPORTED_EVENT',
    );
  } finally {
    store.db.close();
  }
});

test('public ordered webhook bridge is inert unless the exact gate is enabled', async () => {
  let durableCalls = 0;
  const response = await maybeHandleHostedStripeEntitlementWebhook({
    request: new Request('https://once.test/stripe/webhook', {
      method: 'POST',
      body: '{}',
      headers: { 'stripe-signature': 'invalid' },
    }),
    env: {},
    getDurableStub: async () => {
      durableCalls += 1;
      throw new Error('must not resolve');
    },
    nowMs: NOW_MS,
  });
  assert.equal(response, null);
  assert.equal(durableCalls, 0);
});

test('enabled public ordered webhook rejects invalid signature before Durable Object access', async () => {
  let durableCalls = 0;
  const response = await maybeHandleHostedStripeEntitlementWebhook({
    request: new Request('https://once.test/stripe/webhook', {
      method: 'POST',
      body: '{}',
      headers: { 'stripe-signature': `t=${NOW_SECONDS},v1=deadbeef` },
    }),
    env: {
      ONCE_HOSTED_ENTITLEMENT_ORDERING_ENABLED: HOSTED_ENTITLEMENT_ORDERING_ENABLE_VALUE,
      STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
    },
    getDurableStub: async () => {
      durableCalls += 1;
      throw new Error('must not resolve');
    },
    nowMs: NOW_MS,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_stripe_signature');
  assert.equal(durableCalls, 0);
});

test('enabled public ordered webhook verifies signature and forwards only parsed event JSON internally', async () => {
  const secret = 'whsec_fixture';
  const event = subscriptionEvent({ id: 'evt_signed', created: NOW_SECONDS });
  const rawBody = JSON.stringify(event);
  const signature = await stripeSignature(rawBody, secret);
  let durableCalls = 0;

  const response = await maybeHandleHostedStripeEntitlementWebhook({
    request: new Request('https://once.test/stripe/webhook', {
      method: 'POST',
      body: rawBody,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signature,
        cookie: 'must-not-forward=true',
        'x-debug-secret': 'must-not-forward',
      },
    }),
    env: {
      ONCE_HOSTED_ENTITLEMENT_ORDERING_ENABLED: HOSTED_ENTITLEMENT_ORDERING_ENABLE_VALUE,
      STRIPE_WEBHOOK_SECRET: secret,
    },
    getDurableStub: async () => ({
      async fetch(request) {
        durableCalls += 1;
        assert.equal(new URL(request.url).pathname, INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH);
        assert.equal(request.headers.get('cookie'), null);
        assert.equal(request.headers.get('stripe-signature'), null);
        assert.equal(request.headers.get('x-debug-secret'), null);
        assert.deepEqual(await request.json(), event);
        return Response.json({ received: true, processed: true });
      },
    }),
    nowMs: NOW_MS,
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).processed, true);
  assert.equal(durableCalls, 1);
});

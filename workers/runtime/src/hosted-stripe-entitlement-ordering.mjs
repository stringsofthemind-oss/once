import { resolveHostedStripePlan } from './hosted-plan-catalog.mjs';

export const HOSTED_ENTITLEMENT_ORDERING_ENABLE_VALUE = 'phase12d';
export const INTERNAL_HOSTED_ENTITLEMENT_EVENT_HOST = 'q18.internal';
export const INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH = '/__once/hosted/v1/stripe-entitlement-event';
export const PUBLIC_STRIPE_WEBHOOK_PATH = '/stripe/webhook';

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);
const ACTIVE_ENTITLEMENT_STATUSES = new Set(['active', 'trialing']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

export async function verifyStripeWebhookSignature(
  payload,
  signatureHeader,
  secret,
  { toleranceSeconds = 300, nowMs = Date.now() } = {},
) {
  if (typeof payload !== 'string' || !signatureHeader || !secret) return false;
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0) return false;

  const parts = String(signatureHeader).split(',').map((part) => part.trim());
  let timestamp = null;
  const signatures = [];
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') timestamp = value;
    if (key === 'v1') signatures.push(value.toLowerCase());
  }

  if (!timestamp || signatures.length === 0) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber)) return false;
  const currentSeconds = Math.floor(Number(nowMs) / 1000);
  if (!Number.isFinite(currentSeconds)) return false;
  if (Math.abs(currentSeconds - timestampNumber) > toleranceSeconds) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}.${payload}`),
  );
  const expected = Array.from(new Uint8Array(signatureBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return signatures.some((candidate) => timingSafeHexEqual(candidate, expected));
}

function requireEventIdentity(event) {
  const eventId = String(event?.id || '').trim();
  const eventType = String(event?.type || '').trim();
  const eventCreated = Number(event?.created);
  if (!eventId || !eventType || !Number.isSafeInteger(eventCreated) || eventCreated < 0) {
    return null;
  }
  return { eventId, eventType, eventCreated };
}

function subscriptionIdentity(eventType, subscription) {
  const customerId = typeof subscription?.customer === 'string'
    ? subscription.customer
    : String(subscription?.customer?.id || '').trim();
  const subscriptionId = String(subscription?.id || '').trim();
  if (!customerId || !subscriptionId) return null;

  const firstItem = subscription?.items?.data?.[0];
  const priceId = String(firstItem?.price?.id || '').trim();
  const metadataPlan = String(subscription?.metadata?.plan || '').trim().toLowerCase();
  const plan = resolveHostedStripePlan({ priceId, metadataPlan }).plan;
  const status = eventType === 'customer.subscription.deleted'
    ? 'canceled'
    : String(subscription?.status || 'unknown').trim().toLowerCase();

  const rawPeriodEnd = subscription?.current_period_end ?? firstItem?.current_period_end ?? null;
  let currentPeriodEnd = null;
  if (rawPeriodEnd !== null && rawPeriodEnd !== undefined && rawPeriodEnd !== '') {
    const seconds = Number(rawPeriodEnd);
    if (Number.isFinite(seconds) && seconds >= 0) {
      currentPeriodEnd = new Date(seconds * 1000).toISOString();
    }
  }

  return {
    customerId,
    subscriptionId,
    priceId: priceId || null,
    plan,
    status,
    currentPeriodEnd,
  };
}

function initializeOrderingTables(sql) {
  // Keep the legacy event ledger populated as well. That makes rollback from the
  // opt-in ordered handler safe: an event processed here remains a duplicate if
  // traffic later falls back to the pre-existing webhook path.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      processed_at TEXT NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS hosted_entitlement_event_order (
      customer_id TEXT PRIMARY KEY,
      latest_event_created INTEGER NOT NULL,
      latest_event_id TEXT NOT NULL,
      latest_event_type TEXT NOT NULL,
      ambiguous INTEGER NOT NULL DEFAULT 0 CHECK(ambiguous IN (0, 1)),
      updated_at TEXT NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS hosted_entitlement_lifecycle_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      customer_id TEXT,
      event_created INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      processed_at TEXT NOT NULL
    )
  `);
}

function getOrderRow(sql, customerId) {
  return [...sql.exec(
    `
      SELECT latest_event_created, latest_event_id, latest_event_type, ambiguous, updated_at
      FROM hosted_entitlement_event_order
      WHERE customer_id = ?
      LIMIT 1
    `,
    customerId,
  )][0] ?? null;
}

function getExistingEntitlement(sql, customerId) {
  return [...sql.exec(
    `
      SELECT customer_id, subscription_id, plan, status, price_id, current_period_end, updated_at
      FROM stripe_entitlements
      WHERE customer_id = ?
      LIMIT 1
    `,
    customerId,
  )][0] ?? null;
}

function eventAlreadyProcessed(sql, eventId) {
  return [...sql.exec(
    `
      SELECT event_id, outcome
      FROM hosted_entitlement_lifecycle_events
      WHERE event_id = ?
      LIMIT 1
    `,
    eventId,
  )][0] ?? null;
}

function legacyEventAlreadyProcessed(sql, eventId) {
  return [...sql.exec(
    `
      SELECT event_id, type, processed_at
      FROM stripe_events
      WHERE event_id = ?
      LIMIT 1
    `,
    eventId,
  )][0] ?? null;
}

function recordLifecycleEvent(sql, {
  eventId,
  eventType,
  customerId = null,
  eventCreated,
  outcome,
  processedAt,
}) {
  sql.exec(
    `
      INSERT OR IGNORE INTO hosted_entitlement_lifecycle_events (
        event_id, event_type, customer_id, event_created, outcome, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    eventId,
    eventType,
    customerId,
    eventCreated,
    outcome,
    processedAt,
  );
  sql.exec(
    `
      INSERT OR IGNORE INTO stripe_events (event_id, type, processed_at)
      VALUES (?, ?, ?)
    `,
    eventId,
    eventType,
    processedAt,
  );
}

function upsertOrderRow(sql, {
  customerId,
  eventCreated,
  eventId,
  eventType,
  ambiguous,
  updatedAt,
}) {
  sql.exec(
    `
      INSERT INTO hosted_entitlement_event_order (
        customer_id,
        latest_event_created,
        latest_event_id,
        latest_event_type,
        ambiguous,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(customer_id) DO UPDATE SET
        latest_event_created = excluded.latest_event_created,
        latest_event_id = excluded.latest_event_id,
        latest_event_type = excluded.latest_event_type,
        ambiguous = excluded.ambiguous,
        updated_at = excluded.updated_at
    `,
    customerId,
    eventCreated,
    eventId,
    eventType,
    ambiguous ? 1 : 0,
    updatedAt,
  );
}

function writeEntitlement(sql, {
  customerId,
  subscriptionId,
  plan,
  status,
  priceId,
  currentPeriodEnd,
  eventCreated,
}) {
  const lifecycleTime = new Date(eventCreated * 1000).toISOString();
  sql.exec(
    `
      INSERT INTO stripe_entitlements (
        customer_id,
        subscription_id,
        plan,
        status,
        price_id,
        current_period_end,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(customer_id) DO UPDATE SET
        subscription_id = excluded.subscription_id,
        plan = excluded.plan,
        status = excluded.status,
        price_id = excluded.price_id,
        current_period_end = excluded.current_period_end,
        updated_at = excluded.updated_at
    `,
    customerId,
    subscriptionId,
    plan,
    status,
    priceId,
    currentPeriodEnd,
    lifecycleTime,
  );
}

function markEntitlementAmbiguous(sql, { customerId, eventCreated }) {
  const lifecycleTime = new Date(eventCreated * 1000).toISOString();
  const existing = getExistingEntitlement(sql, customerId);
  if (!existing) return;
  sql.exec(
    `
      UPDATE stripe_entitlements
      SET status = 'lifecycle_ambiguous', updated_at = ?
      WHERE customer_id = ?
    `,
    lifecycleTime,
    customerId,
  );
}

function markLegacyEntitlementAmbiguousPreservingBaseline(sql, customerId) {
  sql.exec(
    `
      UPDATE stripe_entitlements
      SET status = 'lifecycle_ambiguous'
      WHERE customer_id = ?
    `,
    customerId,
  );
}

function legacyBaselineRejectsEvent(existingEntitlement, eventCreated) {
  if (!existingEntitlement) return false;
  const baselineMs = Date.parse(String(existingEntitlement.updated_at || ''));
  if (!Number.isFinite(baselineMs)) return true;
  return eventCreated * 1000 <= baselineMs;
}

/**
 * Durable, monotonic Stripe subscription lifecycle application.
 *
 * Older lifecycle events never overwrite newer entitlement state. Two distinct
 * lifecycle events for the same customer with the exact same Stripe `created`
 * second are conservatively treated as ambiguous: the entitlement is made
 * inactive (`lifecycle_ambiguous`) until a strictly newer event resolves it.
 *
 * During first opt-in on an existing legacy entitlement ledger, the existing
 * `updated_at` is treated as a conservative receipt-time floor until a strictly
 * newer Stripe event establishes the new per-customer ordering authority. A
 * legacy active/trialing row is made lifecycle-ambiguous if an incoming event
 * cannot be safely ordered against that receipt-time floor.
 */
export async function handleHostedStripeEntitlementEvent({ request, ctx }) {
  if (!ctx?.storage?.sql?.exec || typeof ctx.storage.sync !== 'function') {
    throw new TypeError('ctx.storage with sql.exec and sync is required');
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let event;
  try {
    event = await request.json();
  } catch {
    return json({ error: 'invalid_stripe_event_json' }, 400);
  }

  const identity = requireEventIdentity(event);
  if (!identity) return json({ error: 'invalid_stripe_event' }, 400);
  const { eventId, eventType, eventCreated } = identity;
  const sql = ctx.storage.sql;
  initializeOrderingTables(sql);

  const duplicate = eventAlreadyProcessed(sql, eventId);
  if (duplicate) {
    return json({ received: true, duplicate: true, event_id: eventId, outcome: duplicate.outcome });
  }

  const processedAt = new Date().toISOString();
  const legacyDuplicate = legacyEventAlreadyProcessed(sql, eventId);
  if (legacyDuplicate) {
    recordLifecycleEvent(sql, {
      eventId,
      eventType,
      eventCreated,
      outcome: 'LEGACY_ALREADY_PROCESSED',
      processedAt,
    });
    await ctx.storage.sync();
    return json({
      received: true,
      duplicate: true,
      event_id: eventId,
      outcome: 'LEGACY_ALREADY_PROCESSED',
    });
  }

  if (!SUBSCRIPTION_EVENTS.has(eventType)) {
    recordLifecycleEvent(sql, {
      eventId,
      eventType,
      eventCreated,
      outcome: 'IGNORED_UNSUPPORTED_EVENT',
      processedAt,
    });
    await ctx.storage.sync();
    return json({ received: true, duplicate: false, processed: false, event_id: eventId, type: eventType });
  }

  const subscription = event?.data?.object || {};
  const parsed = subscriptionIdentity(eventType, subscription);
  if (!parsed) return json({ error: 'stripe_subscription_identity_missing', event_id: eventId }, 400);

  const current = getOrderRow(sql, parsed.customerId);
  const existingEntitlement = getExistingEntitlement(sql, parsed.customerId);

  if (!current && legacyBaselineRejectsEvent(existingEntitlement, eventCreated)) {
    const legacyStatus = String(existingEntitlement?.status || '').trim().toLowerCase();
    const mustFailClosed = ACTIVE_ENTITLEMENT_STATUSES.has(legacyStatus);
    if (mustFailClosed) {
      // Legacy updated_at was receipt time, while ordered events use Stripe's
      // event.created. If those clocks cannot establish order, preserving an
      // active/trialing legacy row could authorize a provider attempt after an
      // unseen cancellation. Make it inactive without moving the receipt-time
      // floor; only an event strictly newer than that floor may establish the
      // new ordering authority.
      markLegacyEntitlementAmbiguousPreservingBaseline(sql, parsed.customerId);
    }
    recordLifecycleEvent(sql, {
      eventId,
      eventType,
      customerId: parsed.customerId,
      eventCreated,
      outcome: mustFailClosed
        ? 'AMBIGUOUS_PRE_ORDERING_BASELINE'
        : 'IGNORED_PRE_ORDERING_BASELINE',
      processedAt,
    });
    await ctx.storage.sync();
    return json({
      received: true,
      duplicate: false,
      processed: false,
      stale: true,
      ...(mustFailClosed ? { ambiguous: true } : {}),
      baseline: 'legacy_entitlement_updated_at',
      event_id: eventId,
      type: eventType,
    });
  }

  if (current && eventCreated < Number(current.latest_event_created)) {
    recordLifecycleEvent(sql, {
      eventId,
      eventType,
      customerId: parsed.customerId,
      eventCreated,
      outcome: 'IGNORED_STALE_EVENT',
      processedAt,
    });
    await ctx.storage.sync();
    return json({
      received: true,
      duplicate: false,
      processed: false,
      stale: true,
      event_id: eventId,
      type: eventType,
    });
  }

  if (
    current &&
    eventCreated === Number(current.latest_event_created) &&
    eventId !== String(current.latest_event_id)
  ) {
    markEntitlementAmbiguous(sql, { customerId: parsed.customerId, eventCreated });
    upsertOrderRow(sql, {
      customerId: parsed.customerId,
      eventCreated,
      eventId,
      eventType,
      ambiguous: true,
      updatedAt: processedAt,
    });
    recordLifecycleEvent(sql, {
      eventId,
      eventType,
      customerId: parsed.customerId,
      eventCreated,
      outcome: 'AMBIGUOUS_SAME_TIMESTAMP',
      processedAt,
    });
    await ctx.storage.sync();
    return json({
      received: true,
      duplicate: false,
      processed: false,
      ambiguous: true,
      event_id: eventId,
      type: eventType,
    });
  }

  writeEntitlement(sql, { ...parsed, eventCreated });
  upsertOrderRow(sql, {
    customerId: parsed.customerId,
    eventCreated,
    eventId,
    eventType,
    ambiguous: false,
    updatedAt: processedAt,
  });
  recordLifecycleEvent(sql, {
    eventId,
    eventType,
    customerId: parsed.customerId,
    eventCreated,
    outcome: 'APPLIED',
    processedAt,
  });
  await ctx.storage.sync();

  return json({
    received: true,
    duplicate: false,
    processed: true,
    event_id: eventId,
    type: eventType,
    entitlement: {
      customer_id: parsed.customerId,
      subscription_id: parsed.subscriptionId,
      plan: parsed.plan,
      status: parsed.status,
      price_id: parsed.priceId,
      current_period_end: parsed.currentPeriodEnd,
      lifecycle_event_created: eventCreated,
    },
  });
}

/**
 * Approval-gated public webhook bridge. When the exact ordering gate is absent,
 * returns null so the existing signed Stripe webhook path remains unchanged.
 */
export async function maybeHandleHostedStripeEntitlementWebhook({
  request,
  env,
  getDurableStub,
  nowMs = Date.now(),
}) {
  const url = new URL(request.url);
  if (url.pathname !== PUBLIC_STRIPE_WEBHOOK_PATH || request.method !== 'POST') return null;
  if (
    String(env?.ONCE_HOSTED_ENTITLEMENT_ORDERING_ENABLED || '') !==
    HOSTED_ENTITLEMENT_ORDERING_ENABLE_VALUE
  ) {
    return null;
  }

  const secret = String(env?.STRIPE_WEBHOOK_SECRET || '');
  if (!secret) return json({ error: 'stripe_webhook_secret_missing' }, 503);

  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: 'invalid_stripe_event_json' }, 400);
  }

  const valid = await verifyStripeWebhookSignature(
    rawBody,
    request.headers.get('stripe-signature'),
    secret,
    { nowMs },
  );
  if (!valid) return json({ error: 'invalid_stripe_signature' }, 400);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid_stripe_event_json' }, 400);
  }

  let stub;
  try {
    stub = await getDurableStub();
  } catch {
    return json({ error: 'stripe_webhook_unavailable' }, 503);
  }

  try {
    const response = await stub.fetch(
      new Request(
        `https://${INTERNAL_HOSTED_ENTITLEMENT_EVENT_HOST}${INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event),
        },
      ),
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return json({ error: 'stripe_webhook_unavailable' }, 503);
  }
}

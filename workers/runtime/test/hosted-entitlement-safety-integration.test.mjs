import test from 'node:test';
import assert from 'node:assert/strict';

import { AmbiguousOutcomeError } from '../../gateway/src/gateway-core.js';
import { HostedGatewayError, sha256Hex } from '../../gateway/src/hosted-gateway-core.js';
import { RuntimeHostedGatewayBinding } from '../src/hosted-gateway-durable.mjs';
import { createRuntimeHostedAdmissionPolicy } from '../src/hosted-entitlement-freshness.mjs';
import {
  handleHostedGatewayInternalRequest,
  INTERNAL_HOSTED_EXECUTE_PATH,
} from '../src/hosted-gateway-transport.mjs';
import {
  handleHostedStripeEntitlementEvent,
  INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH,
} from '../src/hosted-stripe-entitlement-ordering.mjs';
import { storage } from './harness.mjs';

function ctx(store) {
  return { storage: store };
}

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

function setEntitlement(store, tenantId, {
  status = 'active',
  updatedAt,
  currentPeriodEnd,
} = {}) {
  ensureEntitlements(store);
  store.sql.exec(
    `
      INSERT INTO stripe_entitlements (
        customer_id, subscription_id, plan, status, price_id, current_period_end, updated_at
      ) VALUES (?, ?, 'pro', ?, NULL, ?, ?)
      ON CONFLICT(customer_id) DO UPDATE SET
        status = excluded.status,
        current_period_end = excluded.current_period_end,
        updated_at = excluded.updated_at
    `,
    tenantId,
    `sub_${tenantId}`,
    status,
    currentPeriodEnd,
    updatedAt,
  );
}

async function seedApiKey(store, rawKey, tenantId) {
  store.sql.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key_id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      customer_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `);
  store.sql.exec(
    `
      INSERT INTO api_keys (key_id, key_hash, customer_id, created_at, revoked_at)
      VALUES (?, ?, ?, ?, NULL)
    `,
    `key_${tenantId}`,
    await sha256Hex(rawKey),
    tenantId,
    new Date().toISOString(),
  );
}

function body(operationId) {
  return {
    operation_id: operationId,
    target: { provider: 'fixture', action: 'effect.create' },
    payload: { resource: 'r1', amount: 100 },
  };
}

function executeRequest(rawKey, operationId) {
  return new Request(`https://q18.internal${INTERNAL_HOSTED_EXECUTE_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${rawKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body(operationId)),
  });
}

function registrationFactory({ onConstruct = () => {}, execute, reconcile }) {
  return async ({ provider, action }) => {
    if (provider !== 'fixture' || action !== 'effect.create') return null;
    return {
      protection: 'PROTECT',
      bindingVersion: 'fixture-v1',
      canonicalizeEffect(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new HostedGatewayError('invalid_effect_payload', 400);
        }
        return { resource: String(payload.resource), amount: Number(payload.amount) };
      },
      async createAdapter() {
        onConstruct();
        return {
          preflight: async () => undefined,
          execute,
          reconcile: reconcile ?? (async () => ({ status: 'UNKNOWN' })),
        };
      },
    };
  };
}

function freshnessPolicy(store, clock) {
  return createRuntimeHostedAdmissionPolicy({
    ctx: ctx(store),
    env: {
      ONCE_HOSTED_ENTITLEMENT_FRESHNESS_ENABLED: 'phase12d',
      ONCE_HOSTED_ENTITLEMENT_MAX_AGE_SECONDS: '120',
      ONCE_HOSTED_ENTITLEMENT_PERIOD_END_GRACE_SECONDS: '0',
    },
    clock,
    requestLimitPerMinute: 20,
  });
}

async function dispatch(binding, rawKey, operationId) {
  return handleHostedGatewayInternalRequest({
    request: executeRequest(rawKey, operationId),
    binding,
  });
}

function orderedStripeRequest(event) {
  return new Request(`https://q18.internal${INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

function subscriptionEvent({ id, created, tenantId, type = 'customer.subscription.updated' }) {
  return {
    id,
    type,
    created,
    data: {
      object: {
        id: `sub_${tenantId}`,
        customer: tenantId,
        status: 'active',
        current_period_end: created + 3600,
        metadata: { plan: 'pro' },
        items: { data: [] },
      },
    },
  };
}

test('stale entitlement blocks a new provider effect but confirmed replay still fast-replays locally', async () => {
  const store = storage();
  try {
    const tenantId = 'tenant_freshness_integration';
    const rawKey = 'once_test_freshness_integration';
    const startMs = Date.parse('2026-09-27T01:00:00.000Z');
    let nowMs = startMs;

    await seedApiKey(store, rawKey, tenantId);
    setEntitlement(store, tenantId, {
      updatedAt: new Date(startMs - 30_000).toISOString(),
      currentPeriodEnd: new Date(startMs + 3_600_000).toISOString(),
    });

    let effects = 0;
    let constructions = 0;
    const binding = new RuntimeHostedGatewayBinding({
      ctx: ctx(store),
      admissionPolicy: freshnessPolicy(store, () => nowMs),
      resolveRegistration: registrationFactory({
        onConstruct: () => { constructions += 1; },
        execute: async () => ({ providerReference: `effect_${++effects}` }),
      }),
    });

    const first = await dispatch(binding, rawKey, 'fresh-op');
    assert.equal(first.status, 200);
    assert.equal((await first.json()).decision, 'EXECUTE');
    assert.equal(effects, 1);
    assert.equal(constructions, 1);

    nowMs = startMs + 180_000;

    const replay = await dispatch(binding, rawKey, 'fresh-op');
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).decision, 'REPLAY_CONFIRMED');
    assert.equal(effects, 1);
    assert.equal(constructions, 1, 'confirmed replay must not construct a provider adapter');

    const staleNewOperation = await dispatch(binding, rawKey, 'stale-new-op');
    assert.equal(staleNewOperation.status, 503);
    assert.equal((await staleNewOperation.json()).error, 'entitlement_state_stale');
    assert.equal(effects, 1);
    assert.equal(constructions, 1, 'stale entitlement must block before provider construction');
    assert.equal(
      store.sql.exec(
        `SELECT COUNT(*) AS n FROM hosted_metered_operations WHERE operation_id = ?`,
        'stale-new-op',
      )[0].n,
      0,
    );
  } finally {
    store.db.close();
  }
});

test('UNKNOWN can reconcile to CONFIRMED after entitlement freshness expires without re-execution', async () => {
  const store = storage();
  try {
    const tenantId = 'tenant_freshness_unknown_integration';
    const rawKey = 'once_test_freshness_unknown_integration';
    const operationId = 'freshness-unknown-op';
    const startMs = Date.parse('2026-09-27T01:10:00.000Z');
    let nowMs = startMs;

    await seedApiKey(store, rawKey, tenantId);
    setEntitlement(store, tenantId, {
      updatedAt: new Date(startMs - 30_000).toISOString(),
      currentPeriodEnd: new Date(startMs + 3_600_000).toISOString(),
    });

    let effects = 0;
    const firstBinding = new RuntimeHostedGatewayBinding({
      ctx: ctx(store),
      admissionPolicy: freshnessPolicy(store, () => nowMs),
      resolveRegistration: registrationFactory({
        execute: async () => {
          effects += 1;
          throw new AmbiguousOutcomeError('lost acknowledgement');
        },
      }),
    });

    const first = await dispatch(firstBinding, rawKey, operationId);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).decision, 'BLOCK_UNKNOWN');
    assert.equal(effects, 1);

    nowMs = startMs + 180_000;
    let retryExecutions = 0;
    const restartedBinding = new RuntimeHostedGatewayBinding({
      ctx: ctx(store),
      admissionPolicy: freshnessPolicy(store, () => nowMs),
      resolveRegistration: registrationFactory({
        execute: async () => {
          retryExecutions += 1;
          return { providerReference: 'unsafe_reexecute' };
        },
        reconcile: async () => ({
          status: 'CONFIRMED',
          authoritative: true,
          providerReference: 'effect_committed',
          result: { providerReference: 'effect_committed' },
        }),
      }),
    });

    const retry = await dispatch(restartedBinding, rawKey, operationId);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).decision, 'REPLAY_CONFIRMED');
    assert.equal(retryExecutions, 0);
    assert.equal(effects, 1);
  } finally {
    store.db.close();
  }
});

test('same-second ordered lifecycle ambiguity blocks a new hosted provider attempt before adapter construction', async () => {
  const store = storage();
  try {
    const tenantId = 'tenant_ordering_ambiguity_integration';
    const rawKey = 'once_test_ordering_ambiguity_integration';
    const created = Math.floor(Date.parse('2026-09-27T01:20:00.000Z') / 1000);

    await seedApiKey(store, rawKey, tenantId);
    ensureEntitlements(store);

    const firstEvent = await handleHostedStripeEntitlementEvent({
      request: orderedStripeRequest(subscriptionEvent({
        id: 'evt_integration_active',
        created,
        tenantId,
      })),
      ctx: ctx(store),
    });
    assert.equal((await firstEvent.json()).processed, true);

    const ambiguousEvent = await handleHostedStripeEntitlementEvent({
      request: orderedStripeRequest(subscriptionEvent({
        id: 'evt_integration_cancel',
        created,
        tenantId,
        type: 'customer.subscription.deleted',
      })),
      ctx: ctx(store),
    });
    assert.equal((await ambiguousEvent.json()).ambiguous, true);
    assert.equal(
      store.sql.exec(
        `SELECT status FROM stripe_entitlements WHERE customer_id = ?`,
        tenantId,
      )[0].status,
      'lifecycle_ambiguous',
    );

    let effects = 0;
    let constructions = 0;
    const binding = new RuntimeHostedGatewayBinding({
      ctx: ctx(store),
      admissionPolicy: createRuntimeHostedAdmissionPolicy({
        ctx: ctx(store),
        env: {},
        requestLimitPerMinute: 20,
      }),
      resolveRegistration: registrationFactory({
        onConstruct: () => { constructions += 1; },
        execute: async () => ({ providerReference: `unsafe_${++effects}` }),
      }),
    });

    const response = await dispatch(binding, rawKey, 'ambiguous-lifecycle-op');
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'entitlement_inactive');
    assert.equal(effects, 0);
    assert.equal(constructions, 0);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 0);
  } finally {
    store.db.close();
  }
});

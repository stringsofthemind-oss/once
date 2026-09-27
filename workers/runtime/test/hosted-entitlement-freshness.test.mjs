import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOSTED_ENTITLEMENT_FRESHNESS_ENABLE_VALUE,
  RuntimeHostedEntitlementFreshnessPolicy,
  createRuntimeHostedAdmissionPolicy,
} from '../src/hosted-entitlement-freshness.mjs';
import { storage } from './harness.mjs';

const LEGACY_PRO_PRICE_ID = 'price_1UGqPRAHX5spO4zqQcuRzi3S';

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

function seedEntitlement(store, {
  tenantId = 'tenant_freshness',
  status = 'active',
  updatedAt = '2026-09-27T00:25:00.000Z',
  currentPeriodEnd = '2026-09-27T01:30:00.000Z',
} = {}) {
  ensureEntitlements(store);
  store.sql.exec(
    `
      INSERT INTO stripe_entitlements (
        customer_id,
        subscription_id,
        plan,
        status,
        price_id,
        current_period_end,
        updated_at
      ) VALUES (?, ?, 'pro', ?, ?, ?, ?)
      ON CONFLICT(customer_id) DO UPDATE SET
        status = excluded.status,
        price_id = excluded.price_id,
        current_period_end = excluded.current_period_end,
        updated_at = excluded.updated_at
    `,
    tenantId,
    `sub_${tenantId}`,
    status,
    LEGACY_PRO_PRICE_ID,
    currentPeriodEnd,
    updatedAt,
  );
}

function freshnessEnv(overrides = {}) {
  return {
    ONCE_HOSTED_ENTITLEMENT_FRESHNESS_ENABLED:
      HOSTED_ENTITLEMENT_FRESHNESS_ENABLE_VALUE,
    ONCE_HOSTED_ENTITLEMENT_MAX_AGE_SECONDS: '900',
    ONCE_HOSTED_ENTITLEMENT_PERIOD_END_GRACE_SECONDS: '60',
    ...overrides,
  };
}

function createPolicy(store, {
  env = freshnessEnv(),
  clock = () => Date.parse('2026-09-27T00:30:00.000Z'),
} = {}) {
  return createRuntimeHostedAdmissionPolicy({
    ctx: { storage: store },
    env,
    clock,
    requestLimitPerMinute: 20,
  });
}

async function expectGatewayError(promise, { code, status }) {
  await assert.rejects(
    promise,
    (error) => {
      assert.equal(error?.code, code);
      assert.equal(error?.status, status);
      return true;
    },
  );
}

test('freshness guard is inert unless the exact Phase 12D gate is enabled', async () => {
  const store = storage();
  try {
    seedEntitlement(store, {
      currentPeriodEnd: null,
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
    const policy = createPolicy(store, { env: {} });
    assert.equal(policy instanceof RuntimeHostedEntitlementFreshnessPolicy, false);

    const admitted = await policy.authorizeProviderAttempt({
      tenantId: 'tenant_freshness',
      operationId: 'op-disabled',
    });
    assert.equal(admitted.plan, 'pro');
  } finally {
    store.db.close();
  }
});

test('fresh active entitlement admits a new provider attempt', async () => {
  const store = storage();
  try {
    seedEntitlement(store);
    const policy = createPolicy(store);
    assert.equal(policy instanceof RuntimeHostedEntitlementFreshnessPolicy, true);

    const admitted = await policy.authorizeProviderAttempt({
      tenantId: 'tenant_freshness',
      operationId: 'op-fresh',
    });
    assert.equal(admitted.plan, 'pro');
    assert.equal(admitted.limit, 100_000);
  } finally {
    store.db.close();
  }
});

test('stale active entitlement still permits request admission but blocks a new provider attempt', async () => {
  const store = storage();
  try {
    seedEntitlement(store, {
      updatedAt: '2026-09-26T23:00:00.000Z',
      currentPeriodEnd: '2026-09-27T01:30:00.000Z',
    });
    const policy = createPolicy(store);

    const requestAdmission = await policy.authorizeRequest({
      tenantId: 'tenant_freshness',
      operationId: 'op-stale',
      protection: 'PROTECT',
    });
    assert.equal(requestAdmission.protection, 'PROTECT');
    assert.equal(requestAdmission.rate.remaining, 19);

    await expectGatewayError(
      policy.authorizeProviderAttempt({
        tenantId: 'tenant_freshness',
        operationId: 'op-stale',
      }),
      { code: 'entitlement_state_stale', status: 503 },
    );
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 0);
  } finally {
    store.db.close();
  }
});

test('expired entitlement period fails closed even when updated_at is recent', async () => {
  const store = storage();
  try {
    seedEntitlement(store, {
      updatedAt: '2026-09-27T00:29:00.000Z',
      currentPeriodEnd: '2026-09-27T00:28:00.000Z',
    });
    const policy = createPolicy(store);

    await expectGatewayError(
      policy.authorizeProviderAttempt({
        tenantId: 'tenant_freshness',
        operationId: 'op-expired',
      }),
      { code: 'entitlement_state_stale', status: 503 },
    );
  } finally {
    store.db.close();
  }
});

test('period-end grace permits a recent renewal boundary without weakening max-age checks', async () => {
  const store = storage();
  try {
    seedEntitlement(store, {
      updatedAt: '2026-09-27T00:29:30.000Z',
      currentPeriodEnd: '2026-09-27T00:29:30.000Z',
    });
    const policy = createPolicy(store);

    const admitted = await policy.authorizeProviderAttempt({
      tenantId: 'tenant_freshness',
      operationId: 'op-grace',
    });
    assert.equal(admitted.plan, 'pro');
  } finally {
    store.db.close();
  }
});

test('missing or malformed active-entitlement timestamps fail closed', async () => {
  for (const timestamps of [
    { updatedAt: 'not-a-time', currentPeriodEnd: '2026-09-27T01:30:00.000Z' },
    { updatedAt: '2026-09-27T00:29:00.000Z', currentPeriodEnd: null },
    { updatedAt: '2026-09-27T00:40:01.000Z', currentPeriodEnd: '2026-09-27T01:30:00.000Z' },
  ]) {
    const store = storage();
    try {
      seedEntitlement(store, timestamps);
      const policy = createPolicy(store);
      await expectGatewayError(
        policy.authorizeProviderAttempt({
          tenantId: 'tenant_freshness',
          operationId: `op-invalid-${String(timestamps.updatedAt)}`,
        }),
        { code: 'entitlement_state_stale', status: 503 },
      );
    } finally {
      store.db.close();
    }
  }
});

test('inactive entitlement keeps the base 403 semantics instead of being relabeled stale', async () => {
  const store = storage();
  try {
    seedEntitlement(store, {
      status: 'canceled',
      updatedAt: '2020-01-01T00:00:00.000Z',
      currentPeriodEnd: null,
    });
    const policy = createPolicy(store);

    await expectGatewayError(
      policy.authorizeProviderAttempt({
        tenantId: 'tenant_freshness',
        operationId: 'op-canceled',
      }),
      { code: 'entitlement_inactive', status: 403 },
    );
  } finally {
    store.db.close();
  }
});

test('freshness is re-checked at meter reservation after provider preflight time passes', async () => {
  const store = storage();
  try {
    seedEntitlement(store, {
      updatedAt: '2026-09-27T00:29:30.000Z',
      currentPeriodEnd: '2026-09-27T01:30:00.000Z',
    });
    let nowMs = Date.parse('2026-09-27T00:30:00.000Z');
    const policy = createPolicy(store, {
      env: freshnessEnv({ ONCE_HOSTED_ENTITLEMENT_MAX_AGE_SECONDS: '120' }),
      clock: () => nowMs,
    });

    const admitted = await policy.authorizeProviderAttempt({
      tenantId: 'tenant_freshness',
      operationId: 'op-recheck',
    });
    assert.equal(admitted.plan, 'pro');

    nowMs = Date.parse('2026-09-27T00:32:01.000Z');
    await expectGatewayError(
      policy.reserveProtectedOperation({
        tenantId: 'tenant_freshness',
        operationId: 'op-recheck',
        effectHash: 'effect-hash-recheck',
      }),
      { code: 'entitlement_state_stale', status: 503 },
    );
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 0);
  } finally {
    store.db.close();
  }
});

test('freshness gate rejects incomplete or unsafe configuration before use', () => {
  const cases = [
    freshnessEnv({ ONCE_HOSTED_ENTITLEMENT_MAX_AGE_SECONDS: '' }),
    freshnessEnv({ ONCE_HOSTED_ENTITLEMENT_MAX_AGE_SECONDS: '0' }),
    freshnessEnv({ ONCE_HOSTED_ENTITLEMENT_MAX_AGE_SECONDS: '1.5' }),
    freshnessEnv({ ONCE_HOSTED_ENTITLEMENT_PERIOD_END_GRACE_SECONDS: '-1' }),
  ];

  for (const env of cases) {
    const store = storage();
    try {
      ensureEntitlements(store);
      assert.throws(
        () => createPolicy(store, { env }),
        TypeError,
      );
    } finally {
      store.db.close();
    }
  }
});

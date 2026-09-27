import test from 'node:test';
import assert from 'node:assert/strict';

import { HostedGatewayError } from '../../gateway/src/hosted-gateway-core.js';
import { RuntimeHostedAdmissionPolicy } from '../src/hosted-admission-policy.mjs';
import { storage } from './harness.mjs';

const LEGACY_PRO_PRICE_ID = 'price_1UGqPRAHX5spO4zqQcuRzi3S';

function seedEntitlement(
  store,
  tenantId,
  { plan = 'pro', status = 'active', priceId = LEGACY_PRO_PRICE_ID } = {},
) {
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
  store.sql.exec(
    `
      INSERT INTO stripe_entitlements (
        customer_id, subscription_id, plan, status, price_id, current_period_end, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(customer_id) DO UPDATE SET
        plan = excluded.plan,
        status = excluded.status,
        price_id = excluded.price_id,
        updated_at = excluded.updated_at
    `,
    tenantId,
    `sub_${tenantId}`,
    plan,
    status,
    priceId,
    new Date().toISOString(),
  );
}

function request(overrides = {}) {
  return {
    tenantId: 'tenant_a',
    operationId: 'op_1',
    effectHash: 'sha256:aaa',
    protection: 'PROTECT',
    ...overrides,
  };
}

async function rejectsCode(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HostedGatewayError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test('missing entitlement permits rate-only request admission but blocks a new provider attempt before metering', async () => {
  const store = storage();
  try {
    store.sql.exec(`
      CREATE TABLE stripe_entitlements (
        customer_id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        plan TEXT NOT NULL,
        status TEXT NOT NULL,
        price_id TEXT,
        current_period_end TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    const policy = new RuntimeHostedAdmissionPolicy({ ctx: { storage: store } });
    const admission = await policy.authorizeRequest(request());
    assert.equal(admission.protection, 'PROTECT');
    assert.equal(Object.hasOwn(admission, 'plan'), false);
    await rejectsCode(policy.authorizeProviderAttempt(request()), 'entitlement_required', 403);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 0);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_usage_monthly')[0].n, 0);
  } finally {
    store.db.close();
  }
});

test('missing or unknown Stripe price cannot be promoted by the stored plan', async () => {
  const store = storage();
  try {
    seedEntitlement(store, 'tenant_a', { plan: 'pro', priceId: null });
    const policy = new RuntimeHostedAdmissionPolicy({ ctx: { storage: store } });
    const admission = await policy.authorizeRequest(request());
    assert.equal(admission.protection, 'PROTECT');
    assert.equal(Object.hasOwn(admission, 'plan'), false);
    await rejectsCode(policy.authorizeProviderAttempt(request()), 'entitlement_plan_unsupported', 403);

    seedEntitlement(store, 'tenant_a', { plan: 'pro', priceId: 'price_unknown_fixture' });
    await rejectsCode(policy.authorizeProviderAttempt(request()), 'entitlement_plan_unsupported', 403);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 0);
  } finally {
    store.db.close();
  }
});

test('one logical operation is metered once and a later-month replay does not multiply usage', async () => {
  const store = storage();
  try {
    seedEntitlement(store, 'tenant_a');
    let now = Date.parse('2026-09-26T12:00:00.000Z');
    let syncs = 0;
    const originalSync = store.sync;
    store.sync = async () => { syncs += 1; await originalSync(); };
    const policy = new RuntimeHostedAdmissionPolicy({
      ctx: { storage: store },
      clock: () => now,
    });

    const admitted = await policy.authorizeRequest(request());
    assert.equal(admitted.plan, 'pro');
    assert.deepEqual(admitted.usage, { limit: 100_000, used: 0, period: '2026-09' });
    const providerAdmission = await policy.authorizeProviderAttempt(request());
    assert.equal(providerAdmission.plan, 'pro');
    const first = await policy.reserveProtectedOperation(request());
    assert.equal(first.metered, true);
    assert.equal(first.replay, false);
    assert.equal(first.period, '2026-09');
    assert.equal(first.used, 1);
    assert.equal(syncs, 1);

    now = Date.parse('2026-10-03T12:00:00.000Z');
    const laterAdmission = await policy.authorizeRequest(request());
    assert.deepEqual(laterAdmission.usage, { limit: 100_000, used: 0, period: '2026-10' });
    const replay = await policy.reserveProtectedOperation(request());
    assert.equal(replay.metered, false);
    assert.equal(replay.replay, true);
    assert.equal(replay.period, '2026-09');
    assert.equal(syncs, 1);

    const usageRows = store.sql.exec(
      'SELECT period_key, used FROM hosted_usage_monthly ORDER BY period_key',
    );
    assert.deepEqual(
      usageRows.map((row) => ({ period_key: String(row.period_key), used: Number(row.used) })),
      [{ period_key: '2026-09', used: 1 }],
    );
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 1);
  } finally {
    store.db.close();
  }
});

test('same tenant operation cannot reserve a second effect hash', async () => {
  const store = storage();
  try {
    seedEntitlement(store, 'tenant_a');
    const policy = new RuntimeHostedAdmissionPolicy({ ctx: { storage: store } });
    await policy.authorizeRequest(request());
    await policy.authorizeProviderAttempt(request());
    await policy.reserveProtectedOperation(request());
    await rejectsCode(
      policy.reserveProtectedOperation(request({ effectHash: 'sha256:bbb' })),
      'operation_effect_conflict',
      409,
    );
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 1);
    assert.equal(store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used, 1);
  } finally {
    store.db.close();
  }
});

test('monthly logical-operation quota blocks only new reservations and still permits existing logical operation', async () => {
  const store = storage();
  try {
    seedEntitlement(store, 'tenant_a');
    const policy = new RuntimeHostedAdmissionPolicy({
      ctx: { storage: store },
      planLimits: { pro: 2 },
      clock: () => Date.parse('2026-09-26T12:00:00.000Z'),
    });

    const one = request({ operationId: 'op_1', effectHash: 'sha256:1' });
    const two = request({ operationId: 'op_2', effectHash: 'sha256:2' });
    const three = request({ operationId: 'op_3', effectHash: 'sha256:3' });
    await policy.authorizeProviderAttempt(one);
    await policy.reserveProtectedOperation(one);
    await policy.authorizeProviderAttempt(two);
    await policy.reserveProtectedOperation(two);
    await policy.authorizeProviderAttempt(three);
    await rejectsCode(policy.reserveProtectedOperation(three), 'monthly_limit_exceeded', 429);

    const replay = await policy.reserveProtectedOperation(one);
    assert.equal(replay.replay, true);
    assert.equal(replay.metered, false);
    assert.equal(store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used, 2);
  } finally {
    store.db.close();
  }
});

test('inactive entitlement does not block request admission but blocks a new provider attempt', async () => {
  const store = storage();
  try {
    seedEntitlement(store, 'tenant_a', { status: 'canceled' });
    const policy = new RuntimeHostedAdmissionPolicy({ ctx: { storage: store } });
    const admission = await policy.authorizeRequest(request());
    assert.equal(admission.protection, 'PROTECT');
    assert.equal(Object.hasOwn(admission, 'plan'), false);
    await rejectsCode(policy.authorizeProviderAttempt(request()), 'entitlement_inactive', 403);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 0);
  } finally {
    store.db.close();
  }
});

test('request rate limiting is independent from logical-operation metering', async () => {
  const store = storage();
  try {
    seedEntitlement(store, 'tenant_a');
    const policy = new RuntimeHostedAdmissionPolicy({
      ctx: { storage: store },
      requestLimitPerMinute: 2,
      clock: () => Date.parse('2026-09-26T12:00:30.000Z'),
    });

    await policy.authorizeRequest(request());
    await policy.authorizeProviderAttempt(request());
    await policy.reserveProtectedOperation(request());
    await policy.authorizeRequest(request());
    await rejectsCode(policy.authorizeRequest(request()), 'rate_limit_exceeded', 429);
    assert.equal(store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used, 1);
  } finally {
    store.db.close();
  }
});

test('BYPASS requests are rate-limited but never consume protected-operation usage', async () => {
  const store = storage();
  try {
    store.sql.exec(`
      CREATE TABLE stripe_entitlements (
        customer_id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        plan TEXT NOT NULL,
        status TEXT NOT NULL,
        price_id TEXT,
        current_period_end TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    const policy = new RuntimeHostedAdmissionPolicy({ ctx: { storage: store } });
    const result = await policy.authorizeRequest(request({ protection: 'BYPASS' }));
    assert.equal(result.protection, 'BYPASS');
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 0);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_usage_monthly')[0].n, 0);
    assert.equal(store.sql.exec('SELECT request_count FROM hosted_execute_rate_limits')[0].request_count, 1);
  } finally {
    store.db.close();
  }
});

test('concurrent distinct operations cannot oversubscribe a one-operation quota while first sync is pending', async () => {
  const store = storage();
  try {
    seedEntitlement(store, 'tenant_a');
    let releaseSync;
    let syncEntered = false;
    store.sync = () => {
      syncEntered = true;
      return new Promise((resolve) => { releaseSync = resolve; });
    };
    const policy = new RuntimeHostedAdmissionPolicy({
      ctx: { storage: store },
      planLimits: { pro: 1 },
      clock: () => Date.parse('2026-09-26T12:00:00.000Z'),
    });

    const firstRequest = request({ operationId: 'op_1', effectHash: 'sha256:1' });
    const secondRequest = request({ operationId: 'op_2', effectHash: 'sha256:2' });
    const first = policy.reserveProtectedOperation(firstRequest);
    assert.equal(syncEntered, true);

    await rejectsCode(policy.reserveProtectedOperation(secondRequest), 'monthly_limit_exceeded', 429);
    releaseSync();
    const firstResult = await first;
    assert.equal(firstResult.metered, true);
    assert.equal(store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used, 1);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 1);
  } finally {
    store.db.close();
  }
});

test('audit rows use an explicit scalar allowlist and fingerprint raw operation identity', async () => {
  const store = storage();
  try {
    seedEntitlement(store, 'tenant_a');
    const policy = new RuntimeHostedAdmissionPolicy({
      ctx: { storage: store },
      requestLimitPerMinute: 10,
      clock: () => Date.parse('2026-09-27T00:10:00.000Z'),
    });

    const secretFingerprint = 'sha256:payload-secret-fingerprint';
    const rawOperationId = 'op_sensitive_customer_reference_123';
    const input = request({
      operationId: rawOperationId,
      effectHash: secretFingerprint,
    });
    await policy.authorizeRequest(input);
    await policy.authorizeProviderAttempt(input);
    await policy.reserveProtectedOperation(input);

    const columns = store.sql.exec('PRAGMA table_info(hosted_admission_audit_events)')
      .map((row) => String(row.name));
    for (const forbidden of [
      'operation_id',
      'effect_hash',
      'authorization',
      'api_key',
      'payload',
      'metadata',
      'provider_operation_key',
      'provider_result',
      'credential',
    ]) {
      assert.equal(columns.includes(forbidden), false);
    }
    assert.equal(columns.includes('operation_fingerprint'), true);

    const rows = store.sql.exec(`
      SELECT
        event_type,
        tenant_id,
        operation_fingerprint,
        protection,
        plan,
        rate_limit,
        rate_remaining,
        usage_limit,
        usage_used,
        usage_period
      FROM hosted_admission_audit_events
      ORDER BY event_id
    `).map((row) => ({ ...row }));

    assert.equal(rows.length, 3);
    assert.equal(rows[0].event_type, 'REQUEST_ADMITTED');
    assert.equal(rows[0].usage_used, 0);
    assert.equal(rows[1].event_type, 'PROVIDER_ATTEMPT_ADMITTED');
    assert.equal(rows[1].usage_used, 0);
    assert.equal(rows[2].event_type, 'METER_RESERVED');
    assert.equal(rows[2].usage_used, 1);
    assert.match(String(rows[0].operation_fingerprint), /^sha256:[a-f0-9]{64}$/);
    assert.equal(rows[0].operation_fingerprint, rows[1].operation_fingerprint);
    assert.equal(rows[1].operation_fingerprint, rows[2].operation_fingerprint);
    const serialized = JSON.stringify(rows);
    assert.doesNotMatch(serialized, /payload-secret-fingerprint/);
    assert.doesNotMatch(serialized, /op_sensitive_customer_reference_123/);
  } finally {
    store.db.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { HostedGatewayError } from '../../gateway/src/hosted-gateway-core.js';
import { RuntimeHostedAdmissionPolicy } from '../src/hosted-admission-policy.mjs';
import { storage } from './harness.mjs';

function seedEntitlement(store, tenantId, { plan = 'pro', status = 'active' } = {}) {
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
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(customer_id) DO UPDATE SET
        plan = excluded.plan,
        status = excluded.status,
        updated_at = excluded.updated_at
    `,
    tenantId,
    `sub_${tenantId}`,
    plan,
    status,
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

test('missing entitlement fails closed before any logical-operation meter row is created', async () => {
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
    await rejectsCode(policy.authorize(request()), 'entitlement_required', 403);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 0);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_usage_monthly')[0].n, 0);
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

    const first = await policy.authorize(request());
    assert.equal(first.metered, true);
    assert.equal(first.replay, false);
    assert.equal(first.period, '2026-09');
    assert.equal(first.used, 1);
    assert.equal(syncs, 1);

    now = Date.parse('2026-10-03T12:00:00.000Z');
    const replay = await policy.authorize(request());
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

test('same tenant operation cannot be metered under a different effect hash', async () => {
  const store = storage();
  try {
    seedEntitlement(store, 'tenant_a');
    const policy = new RuntimeHostedAdmissionPolicy({ ctx: { storage: store } });
    await policy.authorize(request());
    await rejectsCode(
      policy.authorize(request({ effectHash: 'sha256:bbb' })),
      'operation_effect_conflict',
      409,
    );
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 1);
    assert.equal(store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used, 1);
  } finally {
    store.db.close();
  }
});

test('monthly logical-operation quota blocks only new operations and still permits replay', async () => {
  const store = storage();
  try {
    seedEntitlement(store, 'tenant_a', { plan: 'tiny' });
    const policy = new RuntimeHostedAdmissionPolicy({
      ctx: { storage: store },
      planLimits: { tiny: 2 },
      clock: () => Date.parse('2026-09-26T12:00:00.000Z'),
    });

    await policy.authorize(request({ operationId: 'op_1', effectHash: 'sha256:1' }));
    await policy.authorize(request({ operationId: 'op_2', effectHash: 'sha256:2' }));
    await rejectsCode(
      policy.authorize(request({ operationId: 'op_3', effectHash: 'sha256:3' })),
      'monthly_limit_exceeded',
      429,
    );

    const replay = await policy.authorize(request({ operationId: 'op_1', effectHash: 'sha256:1' }));
    assert.equal(replay.replay, true);
    assert.equal(replay.metered, false);
    assert.equal(store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used, 2);
  } finally {
    store.db.close();
  }
});

test('inactive entitlement fails closed', async () => {
  const store = storage();
  try {
    seedEntitlement(store, 'tenant_a', { status: 'canceled' });
    const policy = new RuntimeHostedAdmissionPolicy({ ctx: { storage: store } });
    await rejectsCode(policy.authorize(request()), 'entitlement_inactive', 403);
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

    await policy.authorize(request());
    const replay = await policy.authorize(request());
    assert.equal(replay.metered, false);
    await rejectsCode(policy.authorize(request()), 'rate_limit_exceeded', 429);
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
    const result = await policy.authorize(request({ protection: 'BYPASS' }));
    assert.equal(result.metered, false);
    assert.equal(result.protection, 'BYPASS');
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 0);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_usage_monthly')[0].n, 0);
    assert.equal(store.sql.exec('SELECT request_count FROM hosted_execute_rate_limits')[0].request_count, 1);
  } finally {
    store.db.close();
  }
});

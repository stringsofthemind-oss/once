import test from 'node:test';
import assert from 'node:assert/strict';

import { AmbiguousOutcomeError } from '../../gateway/src/gateway-core.js';
import { HostedGatewayError, sha256Hex } from '../../gateway/src/hosted-gateway-core.js';
import { RuntimeHostedAdmissionPolicy } from '../src/hosted-admission-policy.mjs';
import { RuntimeHostedGatewayBinding } from '../src/hosted-gateway-durable.mjs';
import {
  handleHostedGatewayInternalRequest,
  INTERNAL_HOSTED_EXECUTE_PATH,
} from '../src/hosted-gateway-transport.mjs';
import { storage } from './harness.mjs';

const LEGACY_PRO_PRICE_ID = 'price_1UGqPRAHX5spO4zqQcuRzi3S';

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

function setEntitlement(store, tenantId, status = 'active') {
  ensureEntitlements(store);
  store.sql.exec(
    `
      INSERT INTO stripe_entitlements (
        customer_id, subscription_id, plan, status, price_id, current_period_end, updated_at
      ) VALUES (?, ?, 'pro', ?, ?, NULL, ?)
      ON CONFLICT(customer_id) DO UPDATE SET
        status = excluded.status,
        price_id = excluded.price_id,
        updated_at = excluded.updated_at
    `,
    tenantId,
    `sub_${tenantId}`,
    status,
    LEGACY_PRO_PRICE_ID,
    new Date().toISOString(),
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

function requestBody(operationId) {
  return {
    operation_id: operationId,
    target: { provider: 'fixture', action: 'effect.create' },
    payload: { resource: 'r1', amount: 100 },
  };
}

function httpRequest(rawKey, operationId) {
  return new Request(`https://q18.internal${INTERNAL_HOSTED_EXECUTE_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${rawKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody(operationId)),
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

async function dispatch(binding, rawKey, operationId) {
  return handleHostedGatewayInternalRequest({
    request: httpRequest(rawKey, operationId),
    binding,
  });
}

function policy(store) {
  return new RuntimeHostedAdmissionPolicy({
    ctx: ctx(store),
    requestLimitPerMinute: 20,
    clock: () => Date.parse('2026-09-27T00:30:00.000Z'),
  });
}

test('confirmed replay remains available after entitlement becomes inactive', async () => {
  const store = storage();
  try {
    const tenantId = 'tenant_lifecycle_replay';
    const rawKey = 'once_test_lifecycle_replay';
    const operationId = 'lifecycle-replay-op';
    await seedApiKey(store, rawKey, tenantId);
    setEntitlement(store, tenantId, 'active');

    let effects = 0;
    const firstBinding = new RuntimeHostedGatewayBinding({
      ctx: ctx(store),
      admissionPolicy: policy(store),
      resolveRegistration: registrationFactory({
        execute: async () => ({ providerReference: `effect_${++effects}` }),
      }),
    });
    const first = await dispatch(firstBinding, rawKey, operationId);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).decision, 'EXECUTE');
    assert.equal(effects, 1);

    setEntitlement(store, tenantId, 'canceled');
    let replayAdapterConstructions = 0;
    const restartedBinding = new RuntimeHostedGatewayBinding({
      ctx: ctx(store),
      admissionPolicy: policy(store),
      resolveRegistration: registrationFactory({
        onConstruct: () => { replayAdapterConstructions += 1; },
        execute: async () => ({ providerReference: `unsafe_${++effects}` }),
      }),
    });
    const replay = await dispatch(restartedBinding, rawKey, operationId);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).decision, 'REPLAY_CONFIRMED');
    assert.equal(effects, 1);
    assert.equal(replayAdapterConstructions, 0);
    assert.equal(store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used, 1);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 1);
  } finally {
    store.db.close();
  }
});

test('UNKNOWN reconciliation to CONFIRMED remains available after entitlement becomes inactive', async () => {
  const store = storage();
  try {
    const tenantId = 'tenant_lifecycle_unknown';
    const rawKey = 'once_test_lifecycle_unknown';
    const operationId = 'lifecycle-unknown-op';
    await seedApiKey(store, rawKey, tenantId);
    setEntitlement(store, tenantId, 'active');

    let providerEffects = 0;
    const firstBinding = new RuntimeHostedGatewayBinding({
      ctx: ctx(store),
      admissionPolicy: policy(store),
      resolveRegistration: registrationFactory({
        execute: async () => {
          providerEffects += 1;
          throw new AmbiguousOutcomeError('lost acknowledgement');
        },
      }),
    });
    const first = await dispatch(firstBinding, rawKey, operationId);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).decision, 'BLOCK_UNKNOWN');
    assert.equal(providerEffects, 1);

    setEntitlement(store, tenantId, 'canceled');
    let retryExecutions = 0;
    const restartedBinding = new RuntimeHostedGatewayBinding({
      ctx: ctx(store),
      admissionPolicy: policy(store),
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
    assert.equal(providerEffects, 1);
    assert.equal(store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used, 1);
  } finally {
    store.db.close();
  }
});

test('authoritative ABSENT after entitlement becomes inactive cannot re-execute the provider action', async () => {
  const store = storage();
  try {
    const tenantId = 'tenant_lifecycle_absent';
    const rawKey = 'once_test_lifecycle_absent';
    const operationId = 'lifecycle-absent-op';
    await seedApiKey(store, rawKey, tenantId);
    setEntitlement(store, tenantId, 'active');

    let firstExecutions = 0;
    const firstBinding = new RuntimeHostedGatewayBinding({
      ctx: ctx(store),
      admissionPolicy: policy(store),
      resolveRegistration: registrationFactory({
        execute: async () => {
          firstExecutions += 1;
          throw new AmbiguousOutcomeError('unknown without committed effect');
        },
      }),
    });
    const first = await dispatch(firstBinding, rawKey, operationId);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).decision, 'BLOCK_UNKNOWN');
    assert.equal(firstExecutions, 1);

    setEntitlement(store, tenantId, 'canceled');
    let retryExecutions = 0;
    const restartedBinding = new RuntimeHostedGatewayBinding({
      ctx: ctx(store),
      admissionPolicy: policy(store),
      resolveRegistration: registrationFactory({
        execute: async () => {
          retryExecutions += 1;
          return { providerReference: 'must_not_execute' };
        },
        reconcile: async () => ({ status: 'ABSENT', authoritative: true }),
      }),
    });
    const retry = await dispatch(restartedBinding, rawKey, operationId);
    assert.equal(retry.status, 403);
    assert.equal((await retry.json()).error, 'entitlement_inactive');
    assert.equal(retryExecutions, 0);
    assert.equal(
      store.sql.exec(
        `SELECT state FROM hosted_gateway_operations WHERE tenant_id = ? AND operation_id = ?`,
        tenantId,
        operationId,
      )[0].state,
      'UNKNOWN',
    );
    assert.equal(store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used, 1);
  } finally {
    store.db.close();
  }
});

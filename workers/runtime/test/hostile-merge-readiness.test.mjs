import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeHostedAdmissionPolicy } from '../src/hosted-admission-policy.mjs';
import {
  HOSTED_STRIPE_CREDENTIAL_ALIAS,
  RuntimeHostedProviderCredentialStore,
} from '../src/hosted-provider-credentials.mjs';
import { ONCE_DEVELOPER_SANDBOX_PRICE_ID } from '../src/hosted-plan-catalog.mjs';
import {
  handleHostedStripeEntitlementEvent,
  INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH,
} from '../src/hosted-stripe-entitlement-ordering.mjs';
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

function stripeEvent({ id, type, created, tenantId, status = 'active', priceId = LEGACY_PRO_PRICE_ID }) {
  return {
    id,
    type,
    created,
    data: {
      object: {
        id: `sub_${tenantId}`,
        customer: tenantId,
        status,
        current_period_end: created + 3600,
        metadata: { plan: 'pro' },
        items: { data: [{ price: { id: priceId } }] },
      },
    },
  };
}

function orderedRequest(event) {
  return new Request(`https://q18.internal${INTERNAL_HOSTED_ENTITLEMENT_EVENT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

test('legacy active receipt-time floor fails closed when Stripe event.created cannot establish order', async () => {
  const store = storage();
  try {
    const tenantId = 'tenant_bootstrap_clock_mismatch';
    const receiptTime = '2026-09-27T01:00:10.000Z';
    ensureEntitlements(store);
    store.sql.exec(
      `
        INSERT INTO stripe_entitlements (
          customer_id, subscription_id, plan, status, price_id, current_period_end, updated_at
        ) VALUES (?, ?, 'pro', 'active', ?, ?, ?)
      `,
      tenantId,
      `sub_${tenantId}`,
      LEGACY_PRO_PRICE_ID,
      '2026-09-27T02:00:00.000Z',
      receiptTime,
    );

    const cancellationCreated = Math.floor(Date.parse('2026-09-27T01:00:05.000Z') / 1000);
    const response = await handleHostedStripeEntitlementEvent({
      request: orderedRequest(stripeEvent({
        id: 'evt_delayed_cancel',
        type: 'customer.subscription.deleted',
        created: cancellationCreated,
        tenantId,
        status: 'canceled',
      })),
      ctx: { storage: store },
    });
    const body = await response.json();
    assert.equal(body.processed, false);
    assert.equal(body.stale, true);
    assert.equal(body.ambiguous, true);

    const entitlement = store.sql.exec(
      `SELECT status, updated_at FROM stripe_entitlements WHERE customer_id = ?`,
      tenantId,
    )[0];
    assert.equal(entitlement.status, 'lifecycle_ambiguous');
    assert.equal(entitlement.updated_at, receiptTime, 'receipt-time bootstrap floor must not move backwards');
    assert.equal(
      store.sql.exec(
        `SELECT COUNT(*) AS n FROM hosted_entitlement_event_order WHERE customer_id = ?`,
        tenantId,
      )[0].n,
      0,
      'an incomparable legacy receipt-time floor must not be promoted into Stripe-created authority',
    );
    assert.equal(
      store.sql.exec(
        `SELECT outcome FROM hosted_entitlement_lifecycle_events WHERE event_id = ?`,
        'evt_delayed_cancel',
      )[0].outcome,
      'AMBIGUOUS_PRE_ORDERING_BASELINE',
    );

    const policy = new RuntimeHostedAdmissionPolicy({ ctx: { storage: store } });
    await assert.rejects(
      policy.authorizeProviderAttempt({ tenantId, operationId: 'op_after_delayed_cancel' }),
      (error) => error?.code === 'entitlement_inactive' && error?.status === 403,
    );

    const resolvingCreated = Math.floor(Date.parse('2026-09-27T01:00:11.000Z') / 1000);
    const resolving = await handleHostedStripeEntitlementEvent({
      request: orderedRequest(stripeEvent({
        id: 'evt_strictly_newer_active',
        type: 'customer.subscription.updated',
        created: resolvingCreated,
        tenantId,
      })),
      ctx: { storage: store },
    });
    assert.equal((await resolving.json()).processed, true);
    const resolved = store.sql.exec(
      `SELECT status, price_id, updated_at FROM stripe_entitlements WHERE customer_id = ?`,
      tenantId,
    )[0];
    assert.equal(resolved.status, 'active');
    assert.equal(resolved.price_id, LEGACY_PRO_PRICE_ID);
    assert.equal(resolved.updated_at, '2026-09-27T01:00:11.000Z');
  } finally {
    store.db.close();
  }
});

test('Developer price remains recognized but commercially unsupported', async () => {
  const store = storage();
  try {
    ensureEntitlements(store);
    store.sql.exec(
      `
        INSERT INTO stripe_entitlements (
          customer_id, subscription_id, plan, status, price_id, current_period_end, updated_at
        ) VALUES ('tenant_developer', 'sub_developer', 'developer', 'active', ?, NULL, ?)
      `,
      ONCE_DEVELOPER_SANDBOX_PRICE_ID,
      new Date().toISOString(),
    );
    const policy = new RuntimeHostedAdmissionPolicy({ ctx: { storage: store } });
    await assert.rejects(
      policy.authorizeProviderAttempt({ tenantId: 'tenant_developer', operationId: 'op_dev' }),
      (error) => error?.code === 'entitlement_plan_unsupported' && error?.status === 403,
    );
  } finally {
    store.db.close();
  }
});

function ensureProviderTables(store) {
  store.sql.exec(`
    CREATE TABLE IF NOT EXISTS provider_versions (
      version_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      encrypted_config TEXT NOT NULL,
      iv_b64 TEXT NOT NULL,
      key_version INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  store.sql.exec(`
    CREATE TABLE IF NOT EXISTS provider_aliases (
      customer_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      current_version_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT,
      PRIMARY KEY (customer_id, provider_name)
    )
  `);
}

function fakeCredentialStore(store, {
  keyVersion,
  pauseOldDecrypt = null,
} = {}) {
  ensureProviderTables(store);
  let paused = false;
  return new RuntimeHostedProviderCredentialStore({
    ctx: { storage: store },
    currentKeyVersion: () => keyVersion,
    encryptConfig: async (_tenant, _provider, _version, config) => ({
      encryptedConfig: JSON.stringify(config),
      ivB64: 'fixture-iv',
      keyVersion,
    }),
    decryptConfig: async (_tenant, _provider, _version, encryptedConfig, _iv, rowKeyVersion) => {
      if (!paused && Number(rowKeyVersion) === 1 && pauseOldDecrypt) {
        paused = true;
        await pauseOldDecrypt();
      }
      return JSON.parse(encryptedConfig);
    },
    clock: () => '2026-09-27T02:00:00.000Z',
  });
}

async function seedOldCredential(store, tenantId, secretKey) {
  const oldStore = fakeCredentialStore(store, { keyVersion: 1 });
  return oldStore.rotateStripeRefundSecret({ tenantId, secretKey });
}

test('rewrap cannot resurrect an alias disabled while old ciphertext is being decrypted', async () => {
  const store = storage();
  try {
    const tenantId = 'tenant_rewrap_disable_race';
    const seeded = await seedOldCredential(store, tenantId, 'sk_test_old_disable_race');
    let release;
    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const rotating = fakeCredentialStore(store, {
      keyVersion: 2,
      pauseOldDecrypt: async () => {
        enteredResolve();
        await gate;
      },
    });

    const rewrap = rotating.rewrapStripeRefundSecret({ tenantId });
    await entered;
    assert.equal(rotating.disableStripeRefundSecret({ tenantId }), true);
    release();

    await assert.rejects(rewrap, /hosted_provider_credential_alias_changed/);
    const alias = store.sql.exec(
      `SELECT current_version_id, disabled_at FROM provider_aliases WHERE customer_id = ? AND provider_name = ?`,
      tenantId,
      HOSTED_STRIPE_CREDENTIAL_ALIAS,
    )[0];
    assert.equal(alias.current_version_id, seeded.versionId);
    assert.ok(alias.disabled_at);
    assert.equal(
      store.sql.exec(
        `SELECT COUNT(*) AS n FROM provider_versions WHERE customer_id = ? AND provider_name = ?`,
        tenantId,
        HOSTED_STRIPE_CREDENTIAL_ALIAS,
      )[0].n,
      1,
      'failed compare-and-swap must roll back the speculative rewrap version',
    );
    assert.equal(await rotating.getStripeRefundSecret({ tenantId }), null);
  } finally {
    store.db.close();
  }
});

test('rewrap cannot overwrite a newer provider credential rotation', async () => {
  const store = storage();
  try {
    const tenantId = 'tenant_rewrap_rotate_race';
    await seedOldCredential(store, tenantId, 'sk_test_old_rotate_race');
    let release;
    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const rotating = fakeCredentialStore(store, {
      keyVersion: 2,
      pauseOldDecrypt: async () => {
        enteredResolve();
        await gate;
      },
    });

    const rewrap = rotating.rewrapStripeRefundSecret({ tenantId });
    await entered;
    const newer = await rotating.rotateStripeRefundSecret({
      tenantId,
      secretKey: 'sk_test_newer_provider_rotation',
    });
    release();

    await assert.rejects(rewrap, /hosted_provider_credential_alias_changed/);
    const alias = store.sql.exec(
      `SELECT current_version_id, disabled_at FROM provider_aliases WHERE customer_id = ? AND provider_name = ?`,
      tenantId,
      HOSTED_STRIPE_CREDENTIAL_ALIAS,
    )[0];
    assert.equal(alias.current_version_id, newer.versionId);
    assert.equal(alias.disabled_at, null);
    assert.equal(
      await rotating.getStripeRefundSecret({ tenantId }),
      'sk_test_newer_provider_rotation',
    );
    assert.equal(
      store.sql.exec(
        `SELECT COUNT(*) AS n FROM provider_versions WHERE customer_id = ? AND provider_name = ?`,
        tenantId,
        HOSTED_STRIPE_CREDENTIAL_ALIAS,
      )[0].n,
      2,
      'failed stale rewrap must not leave a third immutable version behind',
    );
  } finally {
    store.db.close();
  }
});

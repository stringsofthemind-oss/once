import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOSTED_STRIPE_CREDENTIAL_ALIAS,
  HOSTED_STRIPE_CREDENTIAL_TYPE,
  RuntimeHostedProviderCredentialStore,
} from '../src/hosted-provider-credentials.mjs';
import { RuntimeHostedProviderKeyring } from '../src/hosted-provider-keyring.mjs';
import { loadRuntime, storage } from './harness.mjs';

function masterKey(byte = 7) {
  return Buffer.alloc(32, byte).toString('base64');
}

async function createCredentialStore(store, env = { ONCE_PROVIDER_MASTER_KEY: masterKey() }) {
  const { Runtime } = await loadRuntime();
  const runtime = new Runtime({ storage: store }, env);
  const keyring = new RuntimeHostedProviderKeyring({
    env,
    bytesToBase64: (bytes) => runtime.providerBytesToBase64(bytes),
    base64ToBytes: (value) => runtime.providerBase64ToBytes(value),
    aadFor: (customerId, providerName, versionId) =>
      runtime.providerConfigAad(customerId, providerName, versionId),
  });
  const credentials = new RuntimeHostedProviderCredentialStore({
    ctx: { storage: store },
    encryptConfig: (...args) => keyring.encryptConfig(...args),
    decryptConfig: (...args) => keyring.decryptConfig(...args),
    currentKeyVersion: () => keyring.getCurrentKeyVersion(),
    clock: () => '2026-09-26T21:30:00.000Z',
  });
  return { runtime, keyring, credentials };
}

test('hosted Stripe credentials are encrypted, tenant-scoped and rotate immutably', async () => {
  const store = storage();
  try {
    const { credentials } = await createCredentialStore(store);

    const firstA = await credentials.rotateStripeRefundSecret({
      tenantId: 'tenant_a',
      secretKey: 'sk_test_tenant_a_v1',
    });
    const firstB = await credentials.rotateStripeRefundSecret({
      tenantId: 'tenant_b',
      secretKey: 'sk_test_tenant_b_v1',
    });

    assert.equal(firstA.created, true);
    assert.equal(firstA.rotated, false);
    assert.equal(firstA.keyVersion, 1);
    assert.equal(firstB.created, true);
    assert.notEqual(firstA.versionId, firstB.versionId);
    assert.equal(await credentials.getStripeRefundSecret({ tenantId: 'tenant_a' }), 'sk_test_tenant_a_v1');
    assert.equal(await credentials.getStripeRefundSecret({ tenantId: 'tenant_b' }), 'sk_test_tenant_b_v1');

    const rowsBefore = store.sql.exec(`
      SELECT customer_id, provider_name, provider_type, encrypted_config, version_id, key_version
      FROM provider_versions
      WHERE provider_name = ?
      ORDER BY customer_id, created_at
    `, HOSTED_STRIPE_CREDENTIAL_ALIAS);
    assert.equal(rowsBefore.length, 2);
    for (const row of rowsBefore) {
      assert.equal(row.provider_name, HOSTED_STRIPE_CREDENTIAL_ALIAS);
      assert.equal(row.provider_type, HOSTED_STRIPE_CREDENTIAL_TYPE);
      assert.equal(row.key_version, 1);
      assert.match(row.version_id, /^hpc_[a-f0-9]{32}$/);
      assert.doesNotMatch(String(row.encrypted_config), /sk_test_tenant_/);
    }

    const rotatedA = await credentials.rotateStripeRefundSecret({
      tenantId: 'tenant_a',
      secretKey: 'sk_test_tenant_a_v2',
    });
    assert.equal(rotatedA.created, false);
    assert.equal(rotatedA.rotated, true);
    assert.equal(rotatedA.keyVersion, 1);
    assert.notEqual(rotatedA.versionId, firstA.versionId);
    assert.equal(await credentials.getStripeRefundSecret({ tenantId: 'tenant_a' }), 'sk_test_tenant_a_v2');
    assert.equal(await credentials.getStripeRefundSecret({ tenantId: 'tenant_b' }), 'sk_test_tenant_b_v1');

    const rowsAfter = store.sql.exec(`
      SELECT version_id, customer_id
      FROM provider_versions
      WHERE provider_name = ?
      ORDER BY created_at, version_id
    `, HOSTED_STRIPE_CREDENTIAL_ALIAS);
    assert.equal(rowsAfter.length, 3, 'rotation creates a new immutable version row');
    assert.ok(rowsAfter.some((row) => row.version_id === firstA.versionId));
    assert.ok(rowsAfter.some((row) => row.version_id === rotatedA.versionId));

    const aliasA = store.sql.exec(`
      SELECT current_version_id, disabled_at
      FROM provider_aliases
      WHERE customer_id = ? AND provider_name = ?
    `, 'tenant_a', HOSTED_STRIPE_CREDENTIAL_ALIAS)[0];
    assert.equal(aliasA.current_version_id, rotatedA.versionId);
    assert.equal(aliasA.disabled_at, null);
  } finally {
    store.db.close();
  }
});

test('live, restricted and malformed Stripe credentials are rejected before storage', async () => {
  const store = storage();
  try {
    const { credentials } = await createCredentialStore(store);

    for (const secretKey of ['sk_live_never', 'rk_test_not_supported', '', 'not-a-stripe-key']) {
      await assert.rejects(
        credentials.rotateStripeRefundSecret({ tenantId: 'tenant_reject', secretKey }),
      );
    }

    assert.equal(
      store.sql.exec(`SELECT COUNT(*) AS n FROM provider_versions WHERE provider_name = ?`, HOSTED_STRIPE_CREDENTIAL_ALIAS)[0].n,
      0,
    );
    assert.equal(
      store.sql.exec(`SELECT COUNT(*) AS n FROM provider_aliases WHERE provider_name = ?`, HOSTED_STRIPE_CREDENTIAL_ALIAS)[0].n,
      0,
    );
  } finally {
    store.db.close();
  }
});

test('disabled hosted Stripe credential fails closed without deleting immutable history', async () => {
  const store = storage();
  try {
    const { credentials } = await createCredentialStore(store);
    const created = await credentials.rotateStripeRefundSecret({
      tenantId: 'tenant_disabled',
      secretKey: 'sk_test_disabled_fixture',
    });

    assert.equal(credentials.disableStripeRefundSecret({ tenantId: 'tenant_disabled' }), true);
    assert.equal(await credentials.getStripeRefundSecret({ tenantId: 'tenant_disabled' }), null);

    const row = store.sql.exec(`
      SELECT version_id, encrypted_config
      FROM provider_versions
      WHERE version_id = ?
    `, created.versionId)[0];
    assert.equal(row.version_id, created.versionId);
    assert.doesNotMatch(String(row.encrypted_config), /sk_test_disabled_fixture/);
  } finally {
    store.db.close();
  }
});

test('tenant/version tampering cannot decrypt another tenant credential', async () => {
  const store = storage();
  try {
    const { credentials } = await createCredentialStore(store);
    const a = await credentials.rotateStripeRefundSecret({
      tenantId: 'tenant_bound_a',
      secretKey: 'sk_test_bound_a',
    });
    await credentials.rotateStripeRefundSecret({
      tenantId: 'tenant_bound_b',
      secretKey: 'sk_test_bound_b',
    });

    // Point tenant B at tenant A's immutable version. The version lookup itself
    // is tenant-scoped, so the forged alias cannot cross the tenant boundary.
    store.sql.exec(`
      UPDATE provider_aliases
      SET current_version_id = ?
      WHERE customer_id = ? AND provider_name = ?
    `, a.versionId, 'tenant_bound_b', HOSTED_STRIPE_CREDENTIAL_ALIAS);

    await assert.rejects(
      credentials.getStripeRefundSecret({ tenantId: 'tenant_bound_b' }),
      /hosted_provider_credential_version_missing/,
    );
    assert.equal(await credentials.getStripeRefundSecret({ tenantId: 'tenant_bound_a' }), 'sk_test_bound_a');
  } finally {
    store.db.close();
  }
});

test('missing provider master key fails closed during lookup and never returns plaintext', async () => {
  const store = storage();
  try {
    const seeded = await createCredentialStore(store, { ONCE_PROVIDER_MASTER_KEY: masterKey(9) });
    await seeded.credentials.rotateStripeRefundSecret({
      tenantId: 'tenant_master_key',
      secretKey: 'sk_test_master_key_fixture',
    });

    const withoutKey = await createCredentialStore(store, {});
    await assert.rejects(
      withoutKey.credentials.getStripeRefundSecret({ tenantId: 'tenant_master_key' }),
      /provider_master_key_missing/,
    );

    const row = store.sql.exec(`
      SELECT encrypted_config
      FROM provider_versions
      WHERE customer_id = ? AND provider_name = ?
    `, 'tenant_master_key', HOSTED_STRIPE_CREDENTIAL_ALIAS)[0];
    assert.doesNotMatch(String(row.encrypted_config), /sk_test_master_key_fixture/);
  } finally {
    store.db.close();
  }
});

test('provider master-key rotation reads the exact previous key version and writes only the new version', async () => {
  const store = storage();
  try {
    const oldKey = masterKey(11);
    const newKey = masterKey(12);

    const seeded = await createCredentialStore(store, {
      ONCE_PROVIDER_MASTER_KEY: oldKey,
      ONCE_PROVIDER_MASTER_KEY_VERSION: '1',
    });
    const oldCredential = await seeded.credentials.rotateStripeRefundSecret({
      tenantId: 'tenant_key_rotation',
      secretKey: 'sk_test_key_rotation_old',
    });
    assert.equal(oldCredential.keyVersion, 1);

    const rotating = await createCredentialStore(store, {
      ONCE_PROVIDER_MASTER_KEY: newKey,
      ONCE_PROVIDER_MASTER_KEY_VERSION: '2',
      ONCE_PROVIDER_PREVIOUS_MASTER_KEY: oldKey,
      ONCE_PROVIDER_PREVIOUS_MASTER_KEY_VERSION: '1',
    });

    assert.equal(
      await rotating.credentials.getStripeRefundSecret({ tenantId: 'tenant_key_rotation' }),
      'sk_test_key_rotation_old',
    );

    const newCredential = await rotating.credentials.rotateStripeRefundSecret({
      tenantId: 'tenant_key_rotation',
      secretKey: 'sk_test_key_rotation_new',
    });
    assert.equal(newCredential.keyVersion, 2);
    assert.equal(
      await rotating.credentials.getStripeRefundSecret({ tenantId: 'tenant_key_rotation' }),
      'sk_test_key_rotation_new',
    );

    const rows = store.sql.exec(`
      SELECT version_id, key_version, encrypted_config
      FROM provider_versions
      WHERE customer_id = ? AND provider_name = ?
      ORDER BY key_version, version_id
    `, 'tenant_key_rotation', HOSTED_STRIPE_CREDENTIAL_ALIAS);
    assert.deepEqual(rows.map((row) => Number(row.key_version)), [1, 2]);
    for (const row of rows) {
      assert.doesNotMatch(String(row.encrypted_config), /sk_test_key_rotation_/);
    }
  } finally {
    store.db.close();
  }
});

test('old provider key version fails closed when its previous key is no longer configured', async () => {
  const store = storage();
  try {
    const oldKey = masterKey(21);
    const newKey = masterKey(22);
    const seeded = await createCredentialStore(store, {
      ONCE_PROVIDER_MASTER_KEY: oldKey,
      ONCE_PROVIDER_MASTER_KEY_VERSION: '1',
    });
    await seeded.credentials.rotateStripeRefundSecret({
      tenantId: 'tenant_missing_previous',
      secretKey: 'sk_test_missing_previous',
    });

    const withoutPrevious = await createCredentialStore(store, {
      ONCE_PROVIDER_MASTER_KEY: newKey,
      ONCE_PROVIDER_MASTER_KEY_VERSION: '2',
    });
    await assert.rejects(
      withoutPrevious.credentials.getStripeRefundSecret({ tenantId: 'tenant_missing_previous' }),
      /provider_key_version_unsupported/,
    );
  } finally {
    store.db.close();
  }
});

test('rewrap migrates active credential ciphertext to the current master key without exposing or changing the provider secret', async () => {
  const store = storage();
  try {
    const oldKey = masterKey(31);
    const newKey = masterKey(32);
    const seeded = await createCredentialStore(store, {
      ONCE_PROVIDER_MASTER_KEY: oldKey,
      ONCE_PROVIDER_MASTER_KEY_VERSION: '1',
    });
    const oldCredential = await seeded.credentials.rotateStripeRefundSecret({
      tenantId: 'tenant_rewrap',
      secretKey: 'sk_test_rewrap_fixture',
    });

    const rotating = await createCredentialStore(store, {
      ONCE_PROVIDER_MASTER_KEY: newKey,
      ONCE_PROVIDER_MASTER_KEY_VERSION: '2',
      ONCE_PROVIDER_PREVIOUS_MASTER_KEY: oldKey,
      ONCE_PROVIDER_PREVIOUS_MASTER_KEY_VERSION: '1',
    });
    const rewrapped = await rotating.credentials.rewrapStripeRefundSecret({
      tenantId: 'tenant_rewrap',
    });

    assert.equal(rewrapped.rewrapped, true);
    assert.equal(rewrapped.alreadyCurrent, false);
    assert.equal(rewrapped.previousVersionId, oldCredential.versionId);
    assert.equal(rewrapped.keyVersion, 2);
    assert.notEqual(rewrapped.versionId, oldCredential.versionId);
    assert.equal(Object.hasOwn(rewrapped, 'secretKey'), false);

    const currentOnly = await createCredentialStore(store, {
      ONCE_PROVIDER_MASTER_KEY: newKey,
      ONCE_PROVIDER_MASTER_KEY_VERSION: '2',
    });
    assert.equal(
      await currentOnly.credentials.getStripeRefundSecret({ tenantId: 'tenant_rewrap' }),
      'sk_test_rewrap_fixture',
    );

    const rowCountBeforeNoop = Number(store.sql.exec(`
      SELECT COUNT(*) AS n
      FROM provider_versions
      WHERE customer_id = ? AND provider_name = ?
    `, 'tenant_rewrap', HOSTED_STRIPE_CREDENTIAL_ALIAS)[0].n);
    const noOp = await currentOnly.credentials.rewrapStripeRefundSecret({ tenantId: 'tenant_rewrap' });
    const rowCountAfterNoop = Number(store.sql.exec(`
      SELECT COUNT(*) AS n
      FROM provider_versions
      WHERE customer_id = ? AND provider_name = ?
    `, 'tenant_rewrap', HOSTED_STRIPE_CREDENTIAL_ALIAS)[0].n);
    assert.equal(noOp.rewrapped, false);
    assert.equal(noOp.alreadyCurrent, true);
    assert.equal(rowCountAfterNoop, rowCountBeforeNoop);

    const rows = store.sql.exec(`
      SELECT version_id, key_version, encrypted_config
      FROM provider_versions
      WHERE customer_id = ? AND provider_name = ?
      ORDER BY key_version, version_id
    `, 'tenant_rewrap', HOSTED_STRIPE_CREDENTIAL_ALIAS);
    assert.deepEqual(rows.map((row) => Number(row.key_version)), [1, 2]);
    for (const row of rows) {
      assert.doesNotMatch(String(row.encrypted_config), /sk_test_rewrap_fixture/);
    }
  } finally {
    store.db.close();
  }
});

test('ambiguous or conflicting provider keyring configuration fails closed before encryption', async () => {
  const store = storage();
  try {
    const conflicting = await createCredentialStore(store, {
      ONCE_PROVIDER_MASTER_KEY: masterKey(41),
      ONCE_PROVIDER_MASTER_KEY_VERSION: '2',
      ONCE_PROVIDER_PREVIOUS_MASTER_KEY: masterKey(42),
      ONCE_PROVIDER_PREVIOUS_MASTER_KEY_VERSION: '2',
    });
    await assert.rejects(
      conflicting.credentials.rotateStripeRefundSecret({
        tenantId: 'tenant_conflicting_keyring',
        secretKey: 'sk_test_conflicting_keyring',
      }),
      /provider_previous_master_key_version_conflict/,
    );

    const incomplete = await createCredentialStore(store, {
      ONCE_PROVIDER_MASTER_KEY: masterKey(43),
      ONCE_PROVIDER_MASTER_KEY_VERSION: '2',
      ONCE_PROVIDER_PREVIOUS_MASTER_KEY: masterKey(44),
    });
    await assert.rejects(
      incomplete.credentials.rotateStripeRefundSecret({
        tenantId: 'tenant_incomplete_keyring',
        secretKey: 'sk_test_incomplete_keyring',
      }),
      /provider_previous_master_key_configuration_invalid/,
    );
  } finally {
    store.db.close();
  }
});

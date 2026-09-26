export const HOSTED_STRIPE_CREDENTIAL_ALIAS = '__once_hosted_stripe_refund';
export const HOSTED_STRIPE_CREDENTIAL_TYPE = 'hosted_stripe_refund_v1';

const MAX_TENANT_ID_BYTES = 512;
const MAX_STRIPE_SECRET_BYTES = 4096;
const textEncoder = new TextEncoder();

function requireNonEmptyString(value, name, maxBytes) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (maxBytes !== undefined && textEncoder.encode(value).byteLength > maxBytes) {
    throw new TypeError(`${name} is too large`);
  }
  return value;
}

function sqlRows(sql, query, ...params) {
  return [...sql.exec(query, ...params)];
}

function newVersionId() {
  return `hpc_${crypto.randomUUID().replaceAll('-', '')}`;
}

/**
 * Tenant-scoped hosted provider credential storage backed by the runtime's
 * existing provider_versions/provider_aliases tables and provider-config
 * AES-GCM crypto.
 *
 * This class intentionally has no HTTP surface. Provisioning remains a
 * separate, approval-gated concern; hosted execution only receives decrypted
 * credentials after tenant authentication and effect validation.
 */
export class RuntimeHostedProviderCredentialStore {
  constructor({ ctx, encryptConfig, decryptConfig, clock = () => new Date().toISOString() }) {
    if (!ctx?.storage?.sql?.exec) {
      throw new TypeError('ctx.storage.sql.exec is required');
    }
    if (typeof ctx.storage.transactionSync !== 'function') {
      throw new TypeError('ctx.storage.transactionSync is required');
    }
    if (typeof encryptConfig !== 'function') {
      throw new TypeError('encryptConfig must be a function');
    }
    if (typeof decryptConfig !== 'function') {
      throw new TypeError('decryptConfig must be a function');
    }
    if (typeof clock !== 'function') {
      throw new TypeError('clock must be a function');
    }

    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.encryptConfig = encryptConfig;
    this.decryptConfig = decryptConfig;
    this.clock = clock;
  }

  normalizeTenantId(tenantId) {
    return requireNonEmptyString(String(tenantId ?? '').trim(), 'tenantId', MAX_TENANT_ID_BYTES);
  }

  validateStripeTestSecret(secretKey) {
    const secret = requireNonEmptyString(secretKey, 'secretKey', MAX_STRIPE_SECRET_BYTES);
    if (!secret.startsWith('sk_test_')) {
      throw new TypeError('hosted Stripe refund credentials must use an sk_test_ secret');
    }
    return secret;
  }

  async rotateStripeRefundSecret({ tenantId, secretKey }) {
    const tenant = this.normalizeTenantId(tenantId);
    const secret = this.validateStripeTestSecret(secretKey);
    const versionId = newVersionId();

    const encrypted = await this.encryptConfig(
      tenant,
      HOSTED_STRIPE_CREDENTIAL_ALIAS,
      versionId,
      {
        secretKey: secret,
        purpose: 'refund.create',
        mode: 'test',
      },
    );

    if (
      !encrypted ||
      typeof encrypted.encryptedConfig !== 'string' ||
      typeof encrypted.ivB64 !== 'string' ||
      !Number.isInteger(Number(encrypted.keyVersion))
    ) {
      throw new Error('hosted_provider_credential_encryption_invalid');
    }

    const verified = await this.decryptConfig(
      tenant,
      HOSTED_STRIPE_CREDENTIAL_ALIAS,
      versionId,
      encrypted.encryptedConfig,
      encrypted.ivB64,
      encrypted.keyVersion,
    );
    if (
      verified?.secretKey !== secret ||
      verified?.purpose !== 'refund.create' ||
      verified?.mode !== 'test'
    ) {
      throw new Error('hosted_provider_credential_crypto_verification_failed');
    }

    const now = String(this.clock());
    const existingAlias = sqlRows(
      this.sql,
      `
        SELECT current_version_id, disabled_at
        FROM provider_aliases
        WHERE customer_id = ? AND provider_name = ?
        LIMIT 1
      `,
      tenant,
      HOSTED_STRIPE_CREDENTIAL_ALIAS,
    )[0];

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `
          INSERT INTO provider_versions (
            version_id,
            customer_id,
            provider_name,
            provider_type,
            encrypted_config,
            iv_b64,
            key_version,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        versionId,
        tenant,
        HOSTED_STRIPE_CREDENTIAL_ALIAS,
        HOSTED_STRIPE_CREDENTIAL_TYPE,
        encrypted.encryptedConfig,
        encrypted.ivB64,
        Number(encrypted.keyVersion),
        now,
      );

      this.sql.exec(
        `
          INSERT INTO provider_aliases (
            customer_id,
            provider_name,
            current_version_id,
            created_at,
            updated_at,
            disabled_at
          ) VALUES (?, ?, ?, ?, ?, NULL)
          ON CONFLICT(customer_id, provider_name)
          DO UPDATE SET
            current_version_id = excluded.current_version_id,
            updated_at = excluded.updated_at,
            disabled_at = NULL
        `,
        tenant,
        HOSTED_STRIPE_CREDENTIAL_ALIAS,
        versionId,
        now,
        now,
      );
    });

    return {
      created: !existingAlias,
      rotated: Boolean(existingAlias),
      provider: 'stripe',
      action: 'refund.create',
      versionId,
      credentials: 'stored_encrypted',
    };
  }

  async getStripeRefundSecret({ tenantId }) {
    const tenant = this.normalizeTenantId(tenantId);
    const alias = sqlRows(
      this.sql,
      `
        SELECT current_version_id, disabled_at
        FROM provider_aliases
        WHERE customer_id = ? AND provider_name = ?
        LIMIT 1
      `,
      tenant,
      HOSTED_STRIPE_CREDENTIAL_ALIAS,
    )[0];

    if (!alias || alias.disabled_at) return null;

    const versionId = String(alias.current_version_id || '');
    if (!/^hpc_[a-f0-9]{32}$/.test(versionId)) {
      throw new Error('hosted_provider_credential_alias_corrupt');
    }

    const row = sqlRows(
      this.sql,
      `
        SELECT
          version_id,
          customer_id,
          provider_name,
          provider_type,
          encrypted_config,
          iv_b64,
          key_version
        FROM provider_versions
        WHERE
          version_id = ?
          AND customer_id = ?
          AND provider_name = ?
        LIMIT 1
      `,
      versionId,
      tenant,
      HOSTED_STRIPE_CREDENTIAL_ALIAS,
    )[0];

    if (!row) {
      throw new Error('hosted_provider_credential_version_missing');
    }
    if (String(row.provider_type) !== HOSTED_STRIPE_CREDENTIAL_TYPE) {
      throw new Error('hosted_provider_credential_type_mismatch');
    }

    const config = await this.decryptConfig(
      tenant,
      HOSTED_STRIPE_CREDENTIAL_ALIAS,
      versionId,
      row.encrypted_config,
      row.iv_b64,
      row.key_version,
    );

    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      config.purpose !== 'refund.create' ||
      config.mode !== 'test'
    ) {
      throw new Error('hosted_provider_credential_plaintext_invalid');
    }

    return this.validateStripeTestSecret(config.secretKey);
  }

  disableStripeRefundSecret({ tenantId }) {
    const tenant = this.normalizeTenantId(tenantId);
    const now = String(this.clock());
    const alias = sqlRows(
      this.sql,
      `
        SELECT current_version_id, disabled_at
        FROM provider_aliases
        WHERE customer_id = ? AND provider_name = ?
        LIMIT 1
      `,
      tenant,
      HOSTED_STRIPE_CREDENTIAL_ALIAS,
    )[0];
    if (!alias) return false;
    if (alias.disabled_at) return true;

    this.sql.exec(
      `
        UPDATE provider_aliases
        SET disabled_at = ?, updated_at = ?
        WHERE customer_id = ? AND provider_name = ?
      `,
      now,
      now,
      tenant,
      HOSTED_STRIPE_CREDENTIAL_ALIAS,
    );
    return true;
  }
}

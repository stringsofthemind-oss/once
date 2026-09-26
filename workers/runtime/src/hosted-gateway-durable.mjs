import {
  ApiKeyAuthenticator,
  HostedGatewayCore,
  KeyedSerialAuthority,
} from '../../gateway/src/hosted-gateway-core.js';

const VALID_STATES = new Set(['UNKNOWN', 'CONFIRMED']);

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function sqlRows(sql, query, ...params) {
  return [...sql.exec(query, ...params)];
}

/**
 * Reads the existing runtime api_keys table. Raw Once API keys are never stored
 * here; ApiKeyAuthenticator hashes the presented token before this lookup.
 */
export class RuntimeHostedApiKeyStore {
  constructor({ ctx }) {
    if (!ctx?.storage?.sql?.exec) {
      throw new TypeError('ctx.storage.sql.exec is required');
    }
    this.sql = ctx.storage.sql;
  }

  async findActiveByHash(keyHash) {
    requireString(keyHash, 'keyHash');
    const row = sqlRows(
      this.sql,
      `
        SELECT key_id, customer_id
        FROM api_keys
        WHERE key_hash = ? AND revoked_at IS NULL
        LIMIT 1
      `,
      keyHash,
    )[0];

    if (!row) return null;
    return {
      keyId: String(row.key_id),
      tenantId: String(row.customer_id),
    };
  }
}

/**
 * Durable HostedGatewayCore record store backed by the same Durable Object SQL
 * database used by the existing Once runtime. The JSON record is preserved for
 * replay while safety-critical fields are duplicated into typed columns so
 * corruption or accidental cross-tenant reuse can fail closed.
 *
 * Every safety-state write is followed by storage.sync(). In particular, the
 * UNKNOWN record must be flushed before GatewayCore is allowed to cross the
 * external provider boundary. This mirrors the older runtime's proven
 * write-then-sync-before-dispatch rule rather than relying on process timing.
 */
export class RuntimeHostedOperationStorage {
  constructor({ ctx }) {
    if (!ctx?.storage?.sql?.exec) {
      throw new TypeError('ctx.storage.sql.exec is required');
    }
    if (typeof ctx.storage.sync !== 'function') {
      throw new TypeError('ctx.storage.sync is required');
    }
    this.durableStorage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.initialize();
  }

  initialize() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS hosted_gateway_operations (
        operation_key TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        effect_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('UNKNOWN', 'CONFIRMED')),
        provider TEXT NOT NULL,
        action TEXT NOT NULL,
        binding_version TEXT NOT NULL,
        provider_operation_key TEXT NOT NULL,
        provider_reference TEXT,
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, operation_id)
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_hosted_gateway_tenant_state
      ON hosted_gateway_operations (tenant_id, state)
    `);
  }

  async get(operationKey) {
    requireString(operationKey, 'operationKey');
    const row = sqlRows(
      this.sql,
      `
        SELECT
          tenant_id,
          operation_id,
          effect_hash,
          state,
          provider,
          action,
          binding_version,
          provider_operation_key,
          provider_reference,
          record_json,
          created_at,
          updated_at
        FROM hosted_gateway_operations
        WHERE operation_key = ?
        LIMIT 1
      `,
      operationKey,
    )[0];

    if (!row) return null;

    let record;
    try {
      record = JSON.parse(String(row.record_json));
    } catch {
      throw new Error('hosted_gateway_record_corrupt_json');
    }

    requireObject(record, 'hosted gateway record');
    const checks = [
      ['tenantId', row.tenant_id],
      ['operationId', row.operation_id],
      ['effectHash', row.effect_hash],
      ['state', row.state],
      ['provider', row.provider],
      ['action', row.action],
      ['bindingVersion', row.binding_version],
      ['providerOperationKey', row.provider_operation_key],
    ];
    for (const [field, expected] of checks) {
      if (record[field] !== expected) {
        throw new Error(`hosted_gateway_record_corrupt_${field}`);
      }
    }

    return structuredClone(record);
  }

  async put(operationKey, record) {
    requireString(operationKey, 'operationKey');
    requireObject(record, 'record');

    const tenantId = record.tenantId;
    const operationId = record.operationId;
    const effectHash = record.effectHash;
    const state = record.state;
    const provider = record.provider;
    const action = record.action;
    const bindingVersion = record.bindingVersion;
    const providerOperationKey = record.providerOperationKey;

    requireString(tenantId, 'record.tenantId');
    requireString(operationId, 'record.operationId');
    requireString(effectHash, 'record.effectHash');
    requireString(provider, 'record.provider');
    requireString(action, 'record.action');
    requireString(bindingVersion, 'record.bindingVersion');
    requireString(providerOperationKey, 'record.providerOperationKey');
    if (!VALID_STATES.has(state)) {
      throw new TypeError('record.state must be UNKNOWN or CONFIRMED');
    }

    const existing = sqlRows(
      this.sql,
      `
        SELECT tenant_id, operation_id
        FROM hosted_gateway_operations
        WHERE operation_key = ?
        LIMIT 1
      `,
      operationKey,
    )[0];
    if (
      existing &&
      (String(existing.tenant_id) !== tenantId || String(existing.operation_id) !== operationId)
    ) {
      throw new Error('hosted_gateway_operation_key_collision');
    }

    let recordJson;
    try {
      recordJson = JSON.stringify(record);
    } catch {
      throw new TypeError('record must be JSON serializable');
    }
    if (typeof recordJson !== 'string') {
      throw new TypeError('record must be JSON serializable');
    }

    const createdAt = typeof record.createdAt === 'string' && record.createdAt
      ? record.createdAt
      : new Date().toISOString();
    const updatedAt = typeof record.updatedAt === 'string' && record.updatedAt
      ? record.updatedAt
      : createdAt;
    const providerReference = typeof record.providerReference === 'string'
      ? record.providerReference
      : null;

    this.sql.exec(
      `
        INSERT INTO hosted_gateway_operations (
          operation_key,
          tenant_id,
          operation_id,
          effect_hash,
          state,
          provider,
          action,
          binding_version,
          provider_operation_key,
          provider_reference,
          record_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(operation_key) DO UPDATE SET
          effect_hash = excluded.effect_hash,
          state = excluded.state,
          provider = excluded.provider,
          action = excluded.action,
          binding_version = excluded.binding_version,
          provider_operation_key = excluded.provider_operation_key,
          provider_reference = excluded.provider_reference,
          record_json = excluded.record_json,
          updated_at = excluded.updated_at
      `,
      operationKey,
      tenantId,
      operationId,
      effectHash,
      state,
      provider,
      action,
      bindingVersion,
      providerOperationKey,
      providerReference,
      recordJson,
      createdAt,
      updatedAt,
    );

    await this.durableStorage.sync();
  }
}

/**
 * One instance of this binding should live for the lifetime of one Durable
 * Object instance. KeyedSerialAuthority prevents same-instance interleaving for
 * a logical operation. The durable UNKNOWN write remains the crash/restart
 * boundary, so a fresh object instance reconciles rather than blindly executes.
 */
export class RuntimeHostedGatewayBinding {
  constructor({
    ctx,
    resolveRegistration,
    allowedPrefixes = ['once_test_', 'once_stage_'],
    clock,
    authority = new KeyedSerialAuthority(),
  }) {
    if (typeof resolveRegistration !== 'function') {
      throw new TypeError('resolveRegistration must be a function');
    }

    this.storage = new RuntimeHostedOperationStorage({ ctx });
    this.keyStore = new RuntimeHostedApiKeyStore({ ctx });
    this.authenticator = new ApiKeyAuthenticator({
      keyStore: this.keyStore,
      allowedPrefixes,
    });
    this.authority = authority;
    this.core = new HostedGatewayCore({
      authenticator: this.authenticator,
      storage: this.storage,
      authority: this.authority,
      resolveRegistration,
      ...(clock ? { clock } : {}),
    });
  }

  async execute(request) {
    return this.core.execute(request);
  }
}

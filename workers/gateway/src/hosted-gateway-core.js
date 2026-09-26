import { GatewayCore } from './gateway-core.js';

const textEncoder = new TextEncoder();

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

export class HostedGatewayError extends Error {
  constructor(code, status = 400, message = code) {
    super(message);
    this.name = 'HostedGatewayError';
    this.code = code;
    this.status = status;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(String(value)));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function deriveTenantOperationKey(tenantId, operationId) {
  requireString(tenantId, 'tenantId');
  requireString(operationId, 'operationId');
  return `tenant_v1_${await sha256Hex(`once:tenant-operation:v1\n${tenantId}\n${operationId}`)}`;
}

export async function deriveProviderOperationKey({ tenantId, operationId, provider, action }) {
  requireString(tenantId, 'tenantId');
  requireString(operationId, 'operationId');
  requireString(provider, 'provider');
  requireString(action, 'action');
  const digest = await sha256Hex(
    `once:provider-operation:v1\n${tenantId}\n${operationId}\n${provider}\n${action}`,
  );
  return `once_hv1_${digest}`;
}

export async function computeHostedEffectHash({ provider, action, bindingVersion = 'v1', canonicalEffect }) {
  requireString(provider, 'provider');
  requireString(action, 'action');
  requireString(bindingVersion, 'bindingVersion');
  return `sha256:${await sha256Hex(
    `once:hosted-effect:v1\n${provider}\n${action}\n${bindingVersion}\n${canonicalJson(canonicalEffect)}`,
  )}`;
}

export function parseBearerToken(authorization) {
  if (typeof authorization !== 'string') {
    throw new HostedGatewayError('api_key_required', 401);
  }
  const match = authorization.match(/^Bearer[ \t]+([^ \t]+)$/i);
  if (!match) throw new HostedGatewayError('api_key_required', 401);
  return match[1];
}

export class ApiKeyAuthenticator {
  constructor({ keyStore, allowedPrefixes = ['once_test_', 'once_stage_'] }) {
    if (!keyStore?.findActiveByHash) {
      throw new TypeError('keyStore must implement findActiveByHash');
    }
    this.keyStore = keyStore;
    this.allowedPrefixes = [...allowedPrefixes];
  }

  async authenticate(authorization) {
    const rawKey = parseBearerToken(authorization);
    if (!this.allowedPrefixes.some((prefix) => rawKey.startsWith(prefix))) {
      throw new HostedGatewayError('invalid_api_key', 401);
    }
    const keyHash = await sha256Hex(rawKey);
    const record = await this.keyStore.findActiveByHash(keyHash);
    if (!record || typeof record.tenantId !== 'string' || record.tenantId.length === 0) {
      throw new HostedGatewayError('invalid_api_key', 401);
    }
    return {
      tenantId: record.tenantId,
      keyId: record.keyId ?? null,
    };
  }
}

export class KeyedSerialAuthority {
  constructor() {
    this.queues = new Map();
  }

  async withLock(key, fn) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.queues.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }
}

export class TenantScopedOperationStore {
  constructor({ tenantId, storage, authority }) {
    requireString(tenantId, 'tenantId');
    if (!storage?.get || !storage?.put) {
      throw new TypeError('storage must implement get/put');
    }
    if (!authority?.withLock) {
      throw new TypeError('authority must implement withLock');
    }
    this.tenantId = tenantId;
    this.storage = storage;
    this.authority = authority;
  }

  async key(operationId) {
    return deriveTenantOperationKey(this.tenantId, operationId);
  }

  async withLock(operationId, fn) {
    const key = await this.key(operationId);
    return this.authority.withLock(key, fn);
  }

  async get(operationId) {
    const key = await this.key(operationId);
    const value = await this.storage.get(key);
    return value == null ? null : structuredClone(value);
  }

  async put(operationId, record) {
    const key = await this.key(operationId);
    await this.storage.put(key, structuredClone(record));
  }
}

function validateOperationId(operationId) {
  requireString(operationId, 'operation_id');
  const bytes = textEncoder.encode(operationId).byteLength;
  if (bytes > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(operationId)) {
    throw new HostedGatewayError('invalid_operation_id', 400);
  }
}

function validateTarget(target) {
  requireObject(target, 'target');
  requireString(target.provider, 'target.provider');
  requireString(target.action, 'target.action');
}

export class HostedGatewayCore {
  constructor({ authenticator, storage, authority = new KeyedSerialAuthority(), resolveRegistration, clock }) {
    if (!authenticator?.authenticate) {
      throw new TypeError('authenticator must implement authenticate');
    }
    if (!storage?.get || !storage?.put) {
      throw new TypeError('storage must implement get/put');
    }
    if (typeof resolveRegistration !== 'function') {
      throw new TypeError('resolveRegistration must be a function');
    }
    this.authenticator = authenticator;
    this.storage = storage;
    this.authority = authority;
    this.resolveRegistration = resolveRegistration;
    this.clock = clock;
  }

  async execute({ authorization, body }) {
    const principal = await this.authenticator.authenticate(authorization);
    requireObject(body, 'body');

    const operationId = body.operation_id;
    validateOperationId(operationId);
    validateTarget(body.target);

    const provider = String(body.target.provider).trim().toLowerCase();
    const action = String(body.target.action).trim().toLowerCase();
    const registration = await this.resolveRegistration({
      tenantId: principal.tenantId,
      provider,
      action,
    });

    if (!registration) throw new HostedGatewayError('provider_action_not_found', 404);
    if (typeof registration.canonicalizeEffect !== 'function') {
      throw new HostedGatewayError('provider_registration_invalid', 500);
    }
    if (typeof registration.createAdapter !== 'function') {
      throw new HostedGatewayError('provider_registration_invalid', 500);
    }

    const serverProtection = registration.protection ?? 'PROTECT';
    if (serverProtection !== 'PROTECT' && serverProtection !== 'BYPASS') {
      throw new HostedGatewayError('provider_registration_invalid', 500);
    }
    if (body.protection !== undefined && body.protection !== serverProtection) {
      throw new HostedGatewayError('protection_policy_mismatch', 400);
    }

    const canonicalEffect = await registration.canonicalizeEffect(body.payload);
    const bindingVersion = registration.bindingVersion ?? 'v1';
    const effectHash = await computeHostedEffectHash({
      provider,
      action,
      bindingVersion,
      canonicalEffect,
    });

    if (body.effect_hash !== undefined && body.effect_hash !== effectHash) {
      throw new HostedGatewayError('effect_hash_mismatch', 400);
    }

    const providerOperationKey = await deriveProviderOperationKey({
      tenantId: principal.tenantId,
      operationId,
      provider,
      action,
    });

    const adapter = await registration.createAdapter({
      tenantId: principal.tenantId,
      provider,
      action,
      providerOperationKey,
    });

    const metadata = {
      ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? body.metadata
        : {}),
      hosted: {
        tenantId: principal.tenantId,
        provider,
        action,
        bindingVersion,
        providerOperationKey,
      },
    };

    const store = new TenantScopedOperationStore({
      tenantId: principal.tenantId,
      storage: this.storage,
      authority: this.authority,
    });
    const gateway = new GatewayCore({ store, ...(this.clock ? { clock: this.clock } : {}) });

    const result = await gateway.execute(
      {
        operationId,
        effectHash,
        payload: body.payload,
        protection: serverProtection,
        metadata,
      },
      adapter,
    );

    return {
      ...result,
      operationId,
      effectHash,
      provider,
      action,
      tenantId: principal.tenantId,
    };
  }
}

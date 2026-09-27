import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HostedGatewayError,
  computeHostedEffectHash,
  sha256Hex,
} from '../../gateway/src/hosted-gateway-core.js';
import { RuntimeHostedAdmissionPolicy } from '../src/hosted-admission-policy.mjs';
import { RuntimeHostedGatewayBinding } from '../src/hosted-gateway-durable.mjs';
import {
  handleHostedGatewayInternalRequest,
  INTERNAL_HOSTED_EXECUTE_PATH,
} from '../src/hosted-gateway-transport.mjs';
import { storage } from './harness.mjs';

const LEGACY_PRO_PRICE_ID = 'price_1UGqPRAHX5spO4zqQcuRzi3S';

function createContext(store) {
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

function seedEntitlement(store, tenantId, { plan = 'pro', status = 'active' } = {}) {
  ensureEntitlements(store);
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

function body(operationId, amount = 100) {
  return {
    operation_id: operationId,
    target: { provider: 'fixture', action: 'effect.create' },
    payload: { resource: 'resource_1', amount },
  };
}

async function fixtureEffectHash(amount = 100) {
  return computeHostedEffectHash({
    provider: 'fixture',
    action: 'effect.create',
    bindingVersion: 'fixture-v1',
    canonicalEffect: { resource: 'resource_1', amount },
  });
}

function request(key, requestBody) {
  return new Request(`https://q18.internal${INTERNAL_HOSTED_EXECUTE_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
}

function registrationFactory({ execute, preflight = async () => undefined }) {
  return async ({ provider, action }) => {
    if (provider !== 'fixture' || action !== 'effect.create') return null;
    return {
      protection: 'PROTECT',
      bindingVersion: 'fixture-v1',
      canonicalizeEffect(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new HostedGatewayError('invalid_effect_payload', 400);
        }
        if (typeof payload.resource !== 'string' || !payload.resource) {
          throw new HostedGatewayError('invalid_effect_payload', 400);
        }
        if (!Number.isSafeInteger(payload.amount) || payload.amount <= 0) {
          throw new HostedGatewayError('invalid_effect_payload', 400);
        }
        return { resource: payload.resource, amount: payload.amount };
      },
      async createAdapter(context) {
        return {
          preflight: (input) => preflight(input, context),
          execute: (input) => execute(input, context),
          reconcile: async () => ({ status: 'UNKNOWN' }),
        };
      },
    };
  };
}

async function dispatch(binding, key, requestBody) {
  return handleHostedGatewayInternalRequest({
    request: request(key, requestBody),
    binding,
  });
}

test('policy-enabled hosted HTTP executes once, meters once and replay does not multiply usage', async () => {
  const store = storage();
  try {
    const rawKey = 'once_test_admission_transport';
    const tenantId = 'tenant_admission_transport';
    await seedApiKey(store, rawKey, tenantId);
    seedEntitlement(store, tenantId);

    const admissionPolicy = new RuntimeHostedAdmissionPolicy({
      ctx: createContext(store),
      requestLimitPerMinute: 10,
      clock: () => Date.parse('2026-09-27T00:05:00.000Z'),
    });

    let effects = 0;
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      admissionPolicy,
      resolveRegistration: registrationFactory({
        execute: async () => ({ providerReference: `effect_${++effects}` }),
      }),
    });

    const first = await dispatch(binding, rawKey, body('admission-http-op'));
    const replay = await dispatch(binding, rawKey, body('admission-http-op'));

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);

    assert.equal(first.headers.get('x-once-rate-limit-limit'), '10');
    assert.equal(first.headers.get('x-once-rate-limit-remaining'), '9');
    assert.equal(first.headers.get('x-once-usage-limit'), '100000');
    assert.equal(first.headers.get('x-once-usage-used'), '1');
    assert.equal(first.headers.get('x-once-usage-period'), '2026-09');
    assert.equal(first.headers.get('x-once-usage-metered'), 'true');

    assert.equal(replay.headers.get('x-once-rate-limit-limit'), '10');
    assert.equal(replay.headers.get('x-once-rate-limit-remaining'), '8');
    assert.equal(replay.headers.get('x-once-usage-limit'), '100000');
    assert.equal(replay.headers.get('x-once-usage-used'), '1');
    assert.equal(replay.headers.get('x-once-usage-period'), '2026-09');
    assert.equal(replay.headers.get('x-once-usage-metered'), 'false');

    const firstBody = await first.json();
    const replayBody = await replay.json();
    assert.equal(firstBody.decision, 'EXECUTE');
    assert.equal(replayBody.decision, 'REPLAY_CONFIRMED');
    assert.equal(effects, 1);

    assert.equal(
      store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n,
      1,
    );
    assert.equal(
      store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used,
      1,
    );
    assert.equal(
      store.sql.exec('SELECT request_count FROM hosted_execute_rate_limits')[0].request_count,
      2,
    );

    // Admission internals remain out of the response body. Only the reviewed
    // numeric operational header contract is exposed.
    assert.equal(Object.hasOwn(firstBody, 'admission'), false);
    const serialized = JSON.stringify(firstBody);
    assert.doesNotMatch(serialized, /once_test_admission_transport/);
    assert.doesNotMatch(serialized, /tenant_admission_transport/);
  } finally {
    store.db.close();
  }
});

test('policy-enabled hosted HTTP fails closed on missing entitlement before provider construction', async () => {
  const store = storage();
  try {
    const rawKey = 'once_test_admission_missing';
    const tenantId = 'tenant_admission_missing';
    await seedApiKey(store, rawKey, tenantId);
    ensureEntitlements(store);

    const admissionPolicy = new RuntimeHostedAdmissionPolicy({
      ctx: createContext(store),
      clock: () => Date.parse('2026-09-27T00:06:00.000Z'),
    });

    let adapterConstructions = 0;
    let effects = 0;
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      admissionPolicy,
      resolveRegistration: async () => ({
        protection: 'PROTECT',
        bindingVersion: 'fixture-v1',
        canonicalizeEffect: (payload) => ({ resource: payload.resource, amount: payload.amount }),
        async createAdapter() {
          adapterConstructions += 1;
          return {
            execute: async () => ({ providerReference: `effect_${++effects}` }),
            reconcile: async () => ({ status: 'UNKNOWN' }),
          };
        },
      }),
    });

    const response = await dispatch(binding, rawKey, body('missing-entitlement-op'));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'entitlement_required');
    assert.equal(adapterConstructions, 0);
    assert.equal(effects, 0);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 0);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_gateway_operations')[0].n, 0);
  } finally {
    store.db.close();
  }
});

test('policy-enabled hosted HTTP does not meter deterministic provider preflight failure', async () => {
  const store = storage();
  try {
    const rawKey = 'once_test_admission_preflight';
    const tenantId = 'tenant_admission_preflight';
    await seedApiKey(store, rawKey, tenantId);
    seedEntitlement(store, tenantId);

    const admissionPolicy = new RuntimeHostedAdmissionPolicy({
      ctx: createContext(store),
      clock: () => Date.parse('2026-09-27T00:07:00.000Z'),
    });

    let effects = 0;
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      admissionPolicy,
      resolveRegistration: registrationFactory({
        preflight: async () => {
          throw new HostedGatewayError('provider_credentials_unavailable', 503);
        },
        execute: async () => ({ providerReference: `effect_${++effects}` }),
      }),
    });

    const response = await dispatch(binding, rawKey, body('preflight-failure-op'));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'provider_credentials_unavailable');
    assert.equal(effects, 0);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 0);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_gateway_operations')[0].n, 0);
  } finally {
    store.db.close();
  }
});

test('operational headers and audit rows redact authorization, payload and free-form metadata', async () => {
  const store = storage();
  try {
    const rawKey = 'once_test_redaction_secret_123';
    const tenantId = 'tenant_redaction';
    const payloadSecret = 'payload-secret-value-987';
    const metadataSecret = 'metadata-secret-value-654';
    await seedApiKey(store, rawKey, tenantId);
    seedEntitlement(store, tenantId);

    const admissionPolicy = new RuntimeHostedAdmissionPolicy({
      ctx: createContext(store),
      requestLimitPerMinute: 10,
      clock: () => Date.parse('2026-09-27T00:10:00.000Z'),
    });

    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      admissionPolicy,
      resolveRegistration: registrationFactory({
        execute: async () => ({ providerReference: 'effect_redaction' }),
      }),
    });

    const requestBody = body('redaction-op');
    requestBody.payload.note = payloadSecret;
    requestBody.metadata = {
      secret_token: metadataSecret,
      nested: { authorization: rawKey },
    };

    const response = await dispatch(binding, rawKey, requestBody);
    assert.equal(response.status, 200);
    const publicBody = await response.json();
    const headerText = JSON.stringify([...response.headers.entries()]);
    const publicText = JSON.stringify(publicBody);
    const auditText = JSON.stringify(
      store.sql.exec('SELECT * FROM hosted_admission_audit_events ORDER BY event_id').map((row) => ({ ...row })),
    );

    for (const secret of [rawKey, payloadSecret, metadataSecret, 'resource_1']) {
      assert.doesNotMatch(headerText, new RegExp(secret));
      assert.doesNotMatch(auditText, new RegExp(secret));
    }
    for (const secret of [rawKey, payloadSecret, metadataSecret]) {
      assert.doesNotMatch(publicText, new RegExp(secret));
    }

    assert.equal(response.headers.get('x-once-rate-limit-limit'), '10');
    assert.equal(response.headers.get('x-once-usage-metered'), 'true');
    assert.equal(Object.hasOwn(publicBody, 'admission'), false);
  } finally {
    store.db.close();
  }
});

test('orphaned durable meter reservation is reused after a crash before UNKNOWN without double usage', async () => {
  const store = storage();
  try {
    const rawKey = 'once_test_meter_crash_recovery';
    const tenantId = 'tenant_meter_crash_recovery';
    const operationId = 'meter-crash-op';
    await seedApiKey(store, rawKey, tenantId);
    seedEntitlement(store, tenantId);

    const clock = () => Date.parse('2026-09-27T00:12:00.000Z');
    const firstPolicy = new RuntimeHostedAdmissionPolicy({
      ctx: createContext(store),
      requestLimitPerMinute: 10,
      clock,
    });
    const effectHash = await fixtureEffectHash(100);

    // A real request has already constructed its hosted operation storage by
    // the time it reaches the meter reservation boundary. Initialize that table
    // before simulating the crash between meter sync and UNKNOWN write.
    new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      admissionPolicy: firstPolicy,
      resolveRegistration: registrationFactory({
        execute: async () => ({ providerReference: 'never_before_crash' }),
      }),
    });

    // Simulate the exact crash edge: meter reservation is durable, but the
    // process dies before GatewayCore writes its durable UNKNOWN operation.
    await firstPolicy.authorizeRequest({
      tenantId,
      operationId,
      effectHash,
      protection: 'PROTECT',
    });
    const orphan = await firstPolicy.reserveProtectedOperation({
      tenantId,
      operationId,
      effectHash,
      protection: 'PROTECT',
    });
    assert.equal(orphan.metered, true);
    assert.equal(store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used, 1);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_gateway_operations')[0].n, 0);

    let effects = 0;
    const restartedPolicy = new RuntimeHostedAdmissionPolicy({
      ctx: createContext(store),
      requestLimitPerMinute: 10,
      clock,
    });
    const restartedBinding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      admissionPolicy: restartedPolicy,
      resolveRegistration: registrationFactory({
        execute: async () => ({ providerReference: `effect_${++effects}` }),
      }),
    });

    const response = await dispatch(restartedBinding, rawKey, body(operationId, 100));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).decision, 'EXECUTE');
    assert.equal(response.headers.get('x-once-usage-metered'), 'false');
    assert.equal(response.headers.get('x-once-usage-used'), '1');
    assert.equal(effects, 1);
    assert.equal(store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used, 1);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 1);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_gateway_operations')[0].n, 1);
    assert.equal(
      store.sql.exec("SELECT COUNT(*) AS n FROM hosted_admission_audit_events WHERE event_type = 'METER_REUSED'")[0].n,
      1,
    );
  } finally {
    store.db.close();
  }
});

test('orphaned meter reservation fails closed if the logical identity is reused for a different effect', async () => {
  const store = storage();
  try {
    const rawKey = 'once_test_meter_crash_conflict';
    const tenantId = 'tenant_meter_crash_conflict';
    const operationId = 'meter-crash-conflict-op';
    await seedApiKey(store, rawKey, tenantId);
    seedEntitlement(store, tenantId);

    const clock = () => Date.parse('2026-09-27T00:13:00.000Z');
    const firstPolicy = new RuntimeHostedAdmissionPolicy({
      ctx: createContext(store),
      clock,
    });
    const firstEffectHash = await fixtureEffectHash(100);

    new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      admissionPolicy: firstPolicy,
      resolveRegistration: registrationFactory({
        execute: async () => ({ providerReference: 'never_before_crash' }),
      }),
    });

    await firstPolicy.reserveProtectedOperation({
      tenantId,
      operationId,
      effectHash: firstEffectHash,
      protection: 'PROTECT',
    });
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_gateway_operations')[0].n, 0);

    let effects = 0;
    const restartedBinding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      admissionPolicy: new RuntimeHostedAdmissionPolicy({ ctx: createContext(store), clock }),
      resolveRegistration: registrationFactory({
        execute: async () => ({ providerReference: `effect_${++effects}` }),
      }),
    });

    const response = await dispatch(restartedBinding, rawKey, body(operationId, 200));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'operation_effect_conflict');
    assert.equal(effects, 0);
    assert.equal(store.sql.exec('SELECT used FROM hosted_usage_monthly')[0].used, 1);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_metered_operations')[0].n, 1);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_gateway_operations')[0].n, 0);
  } finally {
    store.db.close();
  }
});

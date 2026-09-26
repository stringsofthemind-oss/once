import test from 'node:test';
import assert from 'node:assert/strict';

import { AmbiguousOutcomeError } from '../../gateway/src/gateway-core.js';
import { HostedGatewayError, sha256Hex } from '../../gateway/src/hosted-gateway-core.js';
import { RuntimeHostedGatewayBinding } from '../src/hosted-gateway-durable.mjs';
import {
  handleHostedGatewayInternalRequest,
  INTERNAL_HOSTED_EXECUTE_PATH,
} from '../src/hosted-gateway-transport.mjs';
import { storage } from './harness.mjs';

function createContext(store) {
  return { storage: store };
}

async function seedApiKey(store, rawKey, tenantId, keyId = `key_${tenantId}`) {
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
    keyId,
    await sha256Hex(rawKey),
    tenantId,
    new Date().toISOString(),
  );
}

function body(operationId, amount = 100) {
  return {
    operation_id: operationId,
    target: {
      provider: 'fixture',
      action: 'effect.create',
    },
    payload: {
      resource: 'resource_1',
      amount,
    },
  };
}

function request({
  key,
  requestBody = body('transport-op'),
  method = 'POST',
  contentType = 'application/json',
  rawBody,
} = {}) {
  const headers = new Headers();
  if (key) headers.set('authorization', `Bearer ${key}`);
  if (contentType) headers.set('content-type', contentType);
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = rawBody === undefined ? JSON.stringify(requestBody) : rawBody;
  }
  return new Request(`https://q18.internal${INTERNAL_HOSTED_EXECUTE_PATH}`, init);
}

function registrationFactory({ execute, reconcile = async () => ({ status: 'UNKNOWN' }) }) {
  return async ({ provider, action }) => {
    if (provider !== 'fixture' || action !== 'effect.create') return null;
    return {
      protection: 'PROTECT',
      bindingVersion: 'v1',
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
        return {
          resource: payload.resource,
          amount: payload.amount,
        };
      },
      async createAdapter(context) {
        return {
          execute: (input) => execute(input, context),
          reconcile: (input) => reconcile(input, context),
        };
      },
    };
  };
}

async function dispatch(binding, req) {
  return handleHostedGatewayInternalRequest({ request: req, binding });
}

test('transport rejects non-POST methods without entering gateway binding', async () => {
  let calls = 0;
  const response = await dispatch(
    { execute: async () => { calls += 1; } },
    request({ method: 'GET', contentType: null }),
  );
  assert.equal(response.status, 405);
  assert.equal((await response.json()).error, 'method_not_allowed');
  assert.equal(calls, 0);
});

test('transport rejects non-JSON and malformed JSON before durable execution', async () => {
  let calls = 0;
  const binding = { execute: async () => { calls += 1; } };

  const media = await dispatch(binding, request({ contentType: 'text/plain', rawBody: '{}' }));
  assert.equal(media.status, 415);
  assert.equal((await media.json()).error, 'unsupported_media_type');

  const malformed = await dispatch(binding, request({ rawBody: '{broken' }));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'invalid_json');
  assert.equal(calls, 0);
});

test('missing API key returns 401 and creates no hosted durable record', async () => {
  const store = storage();
  try {
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: registrationFactory({ execute: async () => ({ providerReference: 'never' }) }),
    });
    const response = await dispatch(binding, request());
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'api_key_required');
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_gateway_operations')[0].n, 0);
  } finally {
    store.db.close();
  }
});

test('HTTP transport returns EXECUTE then REPLAY_CONFIRMED with one provider effect', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_transport', 'tenant_transport');
    let effects = 0;
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: registrationFactory({
        execute: async () => ({ providerReference: `effect_${++effects}` }),
      }),
    });

    const first = await dispatch(binding, request({
      key: 'once_test_transport',
      requestBody: body('http-replay-op'),
    }));
    const replay = await dispatch(binding, request({
      key: 'once_test_transport',
      requestBody: body('http-replay-op'),
    }));

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    const firstBody = await first.json();
    const replayBody = await replay.json();
    assert.equal(firstBody.decision, 'EXECUTE');
    assert.equal(firstBody.state, 'CONFIRMED');
    assert.equal(firstBody.operation_id, 'http-replay-op');
    assert.match(firstBody.effect_hash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(firstBody.target, { provider: 'fixture', action: 'effect.create' });
    assert.equal(replayBody.decision, 'REPLAY_CONFIRMED');
    assert.equal(replayBody.result.providerReference, 'effect_1');
    assert.equal(effects, 1);
  } finally {
    store.db.close();
  }
});

test('HTTP transport represents semantic effect drift as 200 + CONFLICT', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_conflict_http', 'tenant_conflict_http');
    let effects = 0;
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: registrationFactory({
        execute: async () => ({ providerReference: `effect_${++effects}` }),
      }),
    });

    await dispatch(binding, request({
      key: 'once_test_conflict_http',
      requestBody: body('http-conflict-op', 100),
    }));
    const conflict = await dispatch(binding, request({
      key: 'once_test_conflict_http',
      requestBody: body('http-conflict-op', 200),
    }));

    assert.equal(conflict.status, 200);
    const conflictBody = await conflict.json();
    assert.equal(conflictBody.decision, 'CONFLICT');
    assert.equal(conflictBody.state, 'CONFIRMED');
    assert.equal(conflictBody.error.code, 'operation_effect_conflict');
    assert.equal(effects, 1);
  } finally {
    store.db.close();
  }
});

test('lost acknowledgement is BLOCK_UNKNOWN then reconciles through HTTP after restart', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_http_restart', 'tenant_http_restart');
    const providerEffects = [];

    const firstBinding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: registrationFactory({
        execute: async (_input, context) => {
          providerEffects.push({
            providerReference: 'effect_committed',
            providerOperationKey: context.providerOperationKey,
          });
          throw new AmbiguousOutcomeError('lost acknowledgement');
        },
      }),
    });

    const first = await dispatch(firstBinding, request({
      key: 'once_test_http_restart',
      requestBody: body('http-restart-op'),
    }));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).decision, 'BLOCK_UNKNOWN');

    let retryExecutions = 0;
    const restartedBinding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: registrationFactory({
        execute: async () => {
          retryExecutions += 1;
          return { providerReference: 'unsafe' };
        },
        reconcile: async (_input, context) => {
          const match = providerEffects.find(
            (effect) => effect.providerOperationKey === context.providerOperationKey,
          );
          return match
            ? {
                status: 'CONFIRMED',
                authoritative: true,
                providerReference: match.providerReference,
                result: { providerReference: match.providerReference },
              }
            : { status: 'UNKNOWN' };
        },
      }),
    });

    const retry = await dispatch(restartedBinding, request({
      key: 'once_test_http_restart',
      requestBody: body('http-restart-op'),
    }));
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).decision, 'REPLAY_CONFIRMED');
    assert.equal(retryExecutions, 0);
    assert.equal(providerEffects.length, 1);
  } finally {
    store.db.close();
  }
});

test('provider truth unavailable remains 200 + BLOCK_UNKNOWN and never re-executes', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_http_unknown', 'tenant_http_unknown');
    let effects = 0;
    const firstBinding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: registrationFactory({
        execute: async () => {
          effects += 1;
          throw new AmbiguousOutcomeError('unknown');
        },
      }),
    });
    await dispatch(firstBinding, request({
      key: 'once_test_http_unknown',
      requestBody: body('http-unknown-op'),
    }));

    let retryExecutions = 0;
    const restartedBinding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: registrationFactory({
        execute: async () => {
          retryExecutions += 1;
          return { providerReference: 'unsafe' };
        },
        reconcile: async () => ({ status: 'UNKNOWN' }),
      }),
    });
    const retry = await dispatch(restartedBinding, request({
      key: 'once_test_http_unknown',
      requestBody: body('http-unknown-op'),
    }));
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).decision, 'BLOCK_UNKNOWN');
    assert.equal(effects, 1);
    assert.equal(retryExecutions, 0);
  } finally {
    store.db.close();
  }
});

test('unexpected post-UNKNOWN failure is opaque 500 while durable state remains UNKNOWN', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_http_opaque', 'tenant_http_opaque');
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: registrationFactory({
        execute: async () => {
          throw new Error('secret provider diagnostic must not escape');
        },
      }),
    });

    const response = await dispatch(binding, request({
      key: 'once_test_http_opaque',
      requestBody: body('http-opaque-op'),
    }));
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.match(text, /gateway_internal_error/);
    assert.doesNotMatch(text, /secret provider diagnostic/);
    assert.equal(
      store.sql.exec(
        `SELECT state FROM hosted_gateway_operations WHERE tenant_id = 'tenant_http_opaque'`,
      )[0].state,
      'UNKNOWN',
    );
  } finally {
    store.db.close();
  }
});

test('same HTTP operation ID remains isolated across authenticated tenants', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_http_a', 'tenant_http_a');
    await seedApiKey(store, 'once_test_http_b', 'tenant_http_b');
    let effects = 0;
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: registrationFactory({
        execute: async () => ({ providerReference: `effect_${++effects}` }),
      }),
    });

    const [a, b] = await Promise.all([
      dispatch(binding, request({ key: 'once_test_http_a', requestBody: body('shared-http-op') })),
      dispatch(binding, request({ key: 'once_test_http_b', requestBody: body('shared-http-op') })),
    ]);
    assert.equal((await a.json()).decision, 'EXECUTE');
    assert.equal((await b.json()).decision, 'EXECUTE');
    assert.equal(effects, 2);
    assert.equal(store.sql.exec('SELECT COUNT(*) AS n FROM hosted_gateway_operations')[0].n, 2);
  } finally {
    store.db.close();
  }
});

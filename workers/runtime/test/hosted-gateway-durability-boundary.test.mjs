import test from 'node:test';
import assert from 'node:assert/strict';

import { sha256Hex } from '../../gateway/src/hosted-gateway-core.js';
import { RuntimeHostedGatewayBinding } from '../src/hosted-gateway-durable.mjs';
import { storage } from './harness.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    `INSERT INTO api_keys (key_id, key_hash, customer_id, created_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`,
    `key_${tenantId}`,
    await sha256Hex(rawKey),
    tenantId,
    new Date().toISOString(),
  );
}

function request(rawKey, operationId) {
  return {
    authorization: `Bearer ${rawKey}`,
    body: {
      operation_id: operationId,
      target: { provider: 'fixture', action: 'effect.create' },
      payload: { resource: 'resource_1', amount: 100 },
    },
  };
}

function registration(execute) {
  return async ({ provider, action }) => {
    if (provider !== 'fixture' || action !== 'effect.create') return null;
    return {
      protection: 'PROTECT',
      bindingVersion: 'v1',
      canonicalizeEffect(payload) {
        return { resource: payload.resource, amount: payload.amount };
      },
      async createAdapter() {
        return {
          execute,
          async reconcile() {
            return { status: 'UNKNOWN' };
          },
        };
      },
    };
  };
}

test('provider dispatch cannot start until durable UNKNOWN sync completes', async () => {
  const store = storage();
  try {
    const rawKey = 'once_test_durable_flush';
    const tenantId = 'tenant_durable_flush';
    await seedApiKey(store, rawKey, tenantId);

    const firstSyncEntered = deferred();
    const releaseFirstSync = deferred();
    const providerStarted = deferred();
    let syncCalls = 0;
    let effects = 0;

    store.sync = async () => {
      syncCalls += 1;
      if (syncCalls === 1) {
        firstSyncEntered.resolve();
        await releaseFirstSync.promise;
      }
    };

    const binding = new RuntimeHostedGatewayBinding({
      ctx: { storage: store },
      resolveRegistration: registration(async () => {
        effects += 1;
        providerStarted.resolve();
        return { providerReference: 'effect_1' };
      }),
    });

    const pending = binding.execute(request(rawKey, 'durable-flush-op'));
    await firstSyncEntered.promise;

    assert.equal(effects, 0, 'provider must not start while UNKNOWN durability is pending');
    assert.equal(
      store.sql.exec(
        `SELECT state FROM hosted_gateway_operations WHERE tenant_id = ?`,
        tenantId,
      )[0].state,
      'UNKNOWN',
      'UNKNOWN is written before the durability barrier',
    );

    releaseFirstSync.resolve();
    await providerStarted.promise;
    const result = await pending;

    assert.equal(result.decision, 'EXECUTE');
    assert.equal(result.state, 'CONFIRMED');
    assert.equal(effects, 1);
    assert.ok(syncCalls >= 2, 'UNKNOWN and CONFIRMED writes are both durability-flushed');
  } finally {
    store.db.close();
  }
});

test('sync failure blocks provider dispatch and leaves operation fail-closed', async () => {
  const store = storage();
  try {
    const rawKey = 'once_test_sync_failure';
    const tenantId = 'tenant_sync_failure';
    await seedApiKey(store, rawKey, tenantId);

    store.sync = async () => {
      throw new Error('durable storage unavailable');
    };
    let effects = 0;

    const binding = new RuntimeHostedGatewayBinding({
      ctx: { storage: store },
      resolveRegistration: registration(async () => {
        effects += 1;
        return { providerReference: 'unsafe' };
      }),
    });

    await assert.rejects(
      binding.execute(request(rawKey, 'sync-failure-op')),
      /durable storage unavailable/,
    );
    assert.equal(effects, 0);
    assert.equal(
      store.sql.exec(
        `SELECT state FROM hosted_gateway_operations WHERE tenant_id = ?`,
        tenantId,
      )[0].state,
      'UNKNOWN',
    );
  } finally {
    store.db.close();
  }
});

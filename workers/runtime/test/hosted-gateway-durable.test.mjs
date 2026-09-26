import test from 'node:test';
import assert from 'node:assert/strict';

import { AmbiguousOutcomeError, GatewayDecision } from '../../gateway/src/gateway-core.js';
import { sha256Hex } from '../../gateway/src/hosted-gateway-core.js';
import { RuntimeHostedGatewayBinding } from '../src/hosted-gateway-durable.mjs';
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

function request(rawKey, operationId, amount = 100) {
  return {
    authorization: `Bearer ${rawKey}`,
    body: {
      operation_id: operationId,
      target: {
        provider: 'fixture',
        action: 'effect.create',
      },
      payload: {
        resource: 'resource_1',
        amount,
      },
    },
  };
}

function registrationFactory({ execute, reconcile = async () => ({ status: 'UNKNOWN' }) }) {
  return async ({ provider, action }) => {
    if (provider !== 'fixture' || action !== 'effect.create') return null;
    return {
      protection: 'PROTECT',
      bindingVersion: 'v1',
      canonicalizeEffect(payload) {
        return {
          resource: String(payload?.resource || ''),
          amount: Number(payload?.amount),
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

test('existing runtime api_keys authenticate two isolated tenants sharing one durable SQL ledger', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_tenant_a', 'tenant_a');
    await seedApiKey(store, 'once_test_tenant_b', 'tenant_b');

    let effects = 0;
    const resolveRegistration = registrationFactory({
      execute: async (_input, context) => ({
        providerReference: `effect_${++effects}`,
        providerOperationKey: context.providerOperationKey,
      }),
    });
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration,
      clock: () => '2026-09-26T18:00:00.000Z',
    });

    const a = await binding.execute(request('once_test_tenant_a', 'same-operation'));
    const b = await binding.execute(request('once_test_tenant_b', 'same-operation'));
    const aReplay = await binding.execute(request('once_test_tenant_a', 'same-operation'));

    assert.equal(a.decision, GatewayDecision.EXECUTE);
    assert.equal(b.decision, GatewayDecision.EXECUTE);
    assert.equal(aReplay.decision, GatewayDecision.REPLAY_CONFIRMED);
    assert.equal(effects, 2);

    const rows = store.sql.exec(`
      SELECT tenant_id, operation_id, state
      FROM hosted_gateway_operations
      ORDER BY tenant_id
    `);
    assert.deepEqual(
      rows.map((row) => [row.tenant_id, row.operation_id, row.state]),
      [
        ['tenant_a', 'same-operation', 'CONFIRMED'],
        ['tenant_b', 'same-operation', 'CONFIRMED'],
      ],
    );
  } finally {
    store.db.close();
  }
});

test('concurrent duplicate deliveries serialize to one provider effect and one durable record', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_concurrency', 'tenant_concurrency');
    let effects = 0;
    const resolveRegistration = registrationFactory({
      execute: async () => {
        effects += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { providerReference: 'effect_one' };
      },
    });
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration,
    });

    const results = await Promise.all([
      binding.execute(request('once_test_concurrency', 'concurrent-op')),
      binding.execute(request('once_test_concurrency', 'concurrent-op')),
      binding.execute(request('once_test_concurrency', 'concurrent-op')),
    ]);

    assert.equal(effects, 1);
    assert.equal(results.filter((result) => result.decision === GatewayDecision.EXECUTE).length, 1);
    assert.equal(
      results.filter((result) => result.decision === GatewayDecision.REPLAY_CONFIRMED).length,
      2,
    );
    assert.equal(
      store.sql.exec('SELECT COUNT(*) AS n FROM hosted_gateway_operations')[0].n,
      1,
    );
  } finally {
    store.db.close();
  }
});

test('same tenant operation with changed effect binding returns CONFLICT without a second effect', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_conflict', 'tenant_conflict');
    let effects = 0;
    const binding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: registrationFactory({
        execute: async () => ({ providerReference: `effect_${++effects}` }),
      }),
    });

    const first = await binding.execute(request('once_test_conflict', 'conflict-op', 100));
    const conflict = await binding.execute(request('once_test_conflict', 'conflict-op', 200));

    assert.equal(first.decision, GatewayDecision.EXECUTE);
    assert.equal(conflict.decision, GatewayDecision.CONFLICT);
    assert.equal(conflict.state, 'CONFIRMED');
    assert.equal(effects, 1);
  } finally {
    store.db.close();
  }
});

test('durable UNKNOWN survives a fresh binding and reconciles before any re-execution', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_restart', 'tenant_restart');

    const providerEffects = [];
    const firstResolveRegistration = registrationFactory({
      execute: async (_input, context) => {
        providerEffects.push({
          providerReference: 'effect_committed',
          providerOperationKey: context.providerOperationKey,
        });
        throw new AmbiguousOutcomeError('acknowledgement lost after provider commit');
      },
    });
    const firstBinding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: firstResolveRegistration,
      clock: () => '2026-09-26T18:01:00.000Z',
    });

    const first = await firstBinding.execute(request('once_test_restart', 'restart-op'));
    assert.equal(first.decision, GatewayDecision.BLOCK_UNKNOWN);
    assert.equal(providerEffects.length, 1);
    assert.equal(
      store.sql.exec(
        `SELECT state FROM hosted_gateway_operations WHERE tenant_id = 'tenant_restart'`,
      )[0].state,
      'UNKNOWN',
    );

    let retryExecuteCalls = 0;
    const restartedResolveRegistration = registrationFactory({
      execute: async () => {
        retryExecuteCalls += 1;
        return { providerReference: 'must_not_execute' };
      },
      reconcile: async (_input, context) => {
        const match = providerEffects.find(
          (effect) => effect.providerOperationKey === context.providerOperationKey,
        );
        if (!match) return { status: 'UNKNOWN' };
        return {
          status: 'CONFIRMED',
          authoritative: true,
          providerReference: match.providerReference,
          result: {
            providerReference: match.providerReference,
          },
        };
      },
    });

    // Simulates a fresh Durable Object instance: new binding/authority, same SQL state.
    const restartedBinding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: restartedResolveRegistration,
      clock: () => '2026-09-26T18:02:00.000Z',
    });
    const retry = await restartedBinding.execute(request('once_test_restart', 'restart-op'));
    const replay = await restartedBinding.execute(request('once_test_restart', 'restart-op'));

    assert.equal(retry.decision, GatewayDecision.REPLAY_CONFIRMED);
    assert.equal(replay.decision, GatewayDecision.REPLAY_CONFIRMED);
    assert.equal(retryExecuteCalls, 0);
    assert.equal(providerEffects.length, 1);
    assert.equal(
      store.sql.exec(
        `SELECT state FROM hosted_gateway_operations WHERE tenant_id = 'tenant_restart'`,
      )[0].state,
      'CONFIRMED',
    );
  } finally {
    store.db.close();
  }
});

test('provider truth unavailable after durable UNKNOWN remains BLOCK_UNKNOWN after restart', async () => {
  const store = storage();
  try {
    await seedApiKey(store, 'once_test_unknown', 'tenant_unknown');

    let effects = 0;
    const firstBinding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: registrationFactory({
        execute: async () => {
          effects += 1;
          throw new AmbiguousOutcomeError('provider outcome unknown');
        },
      }),
    });
    assert.equal(
      (await firstBinding.execute(request('once_test_unknown', 'unknown-op'))).decision,
      GatewayDecision.BLOCK_UNKNOWN,
    );

    let retryExecuteCalls = 0;
    const restartedBinding = new RuntimeHostedGatewayBinding({
      ctx: createContext(store),
      resolveRegistration: registrationFactory({
        execute: async () => {
          retryExecuteCalls += 1;
          return { providerReference: 'unsafe' };
        },
        reconcile: async () => ({ status: 'UNKNOWN' }),
      }),
    });

    const retry = await restartedBinding.execute(request('once_test_unknown', 'unknown-op'));
    assert.equal(retry.decision, GatewayDecision.BLOCK_UNKNOWN);
    assert.equal(effects, 1);
    assert.equal(retryExecuteCalls, 0);
  } finally {
    store.db.close();
  }
});

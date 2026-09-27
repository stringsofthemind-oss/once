import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HostedGatewayCore,
  HostedGatewayError,
  computeHostedEffectHash,
} from '../src/hosted-gateway-core.js';

class MemoryStorage {
  constructor() {
    this.records = new Map();
  }
  async get(key) {
    return this.records.get(key) ?? null;
  }
  async put(key, value) {
    this.records.set(key, structuredClone(value));
  }
}

function body(amount = 100) {
  return {
    operation_id: 'op_1',
    target: { provider: 'fixture', action: 'effect.create' },
    payload: { resource: 'r1', amount },
  };
}

function registration(events, { preflightError = null } = {}) {
  return {
    protection: 'PROTECT',
    bindingVersion: 'fixture-v1',
    canonicalizeEffect(payload) {
      events.push('canonicalize');
      return { resource: String(payload.resource), amount: Number(payload.amount) };
    },
    createAdapter() {
      events.push('adapter_construct');
      return {
        async preflight() {
          events.push('provider_preflight');
          if (preflightError) throw preflightError;
        },
        async execute() {
          events.push('provider_execute');
          return { providerReference: 'effect_1' };
        },
        async reconcile() {
          events.push('provider_reconcile');
          return { status: 'UNKNOWN' };
        },
      };
    },
  };
}

function allowPolicy(events, capture = {}) {
  return {
    async authorizeRequest(context) {
      events.push('request_admission');
      capture.requestContext = context;
      return { protection: 'PROTECT', rate: { remaining: 119 } };
    },
    async authorizeProviderAttempt(context) {
      events.push('provider_attempt_admission');
      capture.providerAttemptContext = context;
      return { protection: 'PROTECT', plan: 'pro', limit: 100_000 };
    },
    async reserveProtectedOperation(context) {
      events.push('meter_reserve');
      capture.meterContext = context;
      return { metered: true, used: 1, period: '2026-09' };
    },
  };
}

test('request admission precedes state work, provider-attempt admission precedes preflight, and metering follows preflight', async () => {
  const events = [];
  const capture = {};
  const core = new HostedGatewayCore({
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return { tenantId: 'tenant_a', keyId: 'key_a' };
      },
    },
    storage: new MemoryStorage(),
    resolveRegistration: async () => registration(events),
    admissionPolicy: allowPolicy(events, capture),
  });

  const result = await core.execute({ authorization: 'Bearer once_test_a', body: body() });

  assert.deepEqual(events, [
    'authenticate',
    'canonicalize',
    'request_admission',
    'provider_attempt_admission',
    'adapter_construct',
    'provider_preflight',
    'meter_reserve',
    'provider_execute',
  ]);
  assert.equal(capture.requestContext.tenantId, 'tenant_a');
  assert.equal(capture.requestContext.operationId, 'op_1');
  assert.equal(capture.requestContext.provider, 'fixture');
  assert.equal(capture.requestContext.action, 'effect.create');
  assert.equal(capture.requestContext.bindingVersion, 'fixture-v1');
  assert.equal(capture.requestContext.protection, 'PROTECT');
  assert.match(capture.requestContext.effectHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(capture.requestContext.providerOperationKey, /^once_hv1_[a-f0-9]{64}$/);
  assert.equal(capture.providerAttemptContext.effectHash, capture.requestContext.effectHash);
  assert.equal(capture.meterContext.effectHash, capture.requestContext.effectHash);
  assert.deepEqual(result.admission, {
    protection: 'PROTECT',
    rate: { remaining: 119 },
    plan: 'pro',
    limit: 100_000,
    meter: { metered: true, used: 1, period: '2026-09' },
  });
});

test('request admission denial prevents state work, adapter construction and provider crossing', async () => {
  const events = [];
  let providerAdmissionCalls = 0;
  let reserveCalls = 0;
  const core = new HostedGatewayCore({
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return { tenantId: 'tenant_a', keyId: 'key_a' };
      },
    },
    storage: new MemoryStorage(),
    resolveRegistration: async () => registration(events),
    admissionPolicy: {
      async authorizeRequest() {
        events.push('request_admission');
        throw new HostedGatewayError('rate_limit_exceeded', 429);
      },
      async authorizeProviderAttempt() {
        providerAdmissionCalls += 1;
      },
      async reserveProtectedOperation() {
        reserveCalls += 1;
      },
    },
  });

  await assert.rejects(
    core.execute({ authorization: 'Bearer once_test_a', body: body() }),
    (error) => error instanceof HostedGatewayError && error.code === 'rate_limit_exceeded',
  );
  assert.deepEqual(events, ['authenticate', 'canonicalize', 'request_admission']);
  assert.equal(providerAdmissionCalls, 0);
  assert.equal(reserveCalls, 0);
});

test('provider-attempt admission denial happens before lazy adapter construction or preflight', async () => {
  const events = [];
  let reserveCalls = 0;
  const core = new HostedGatewayCore({
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return { tenantId: 'tenant_a', keyId: 'key_a' };
      },
    },
    storage: new MemoryStorage(),
    resolveRegistration: async () => registration(events),
    admissionPolicy: {
      async authorizeRequest() {
        events.push('request_admission');
        return { protection: 'PROTECT', rate: { remaining: 1 } };
      },
      async authorizeProviderAttempt() {
        events.push('provider_attempt_admission');
        throw new HostedGatewayError('entitlement_required', 403);
      },
      async reserveProtectedOperation() {
        reserveCalls += 1;
      },
    },
  });

  await assert.rejects(
    core.execute({ authorization: 'Bearer once_test_a', body: body() }),
    (error) => error instanceof HostedGatewayError && error.code === 'entitlement_required',
  );
  assert.deepEqual(events, [
    'authenticate',
    'canonicalize',
    'request_admission',
    'provider_attempt_admission',
  ]);
  assert.equal(reserveCalls, 0);
});

test('effect-hash mismatch is rejected before request admission', async () => {
  const events = [];
  let admissionCalls = 0;
  let providerAdmissionCalls = 0;
  let reserveCalls = 0;
  const canonicalEffect = { resource: 'r1', amount: 100 };
  const wrongHash = await computeHostedEffectHash({
    provider: 'fixture',
    action: 'effect.create',
    bindingVersion: 'fixture-v1',
    canonicalEffect: { resource: 'different', amount: 100 },
  });

  const core = new HostedGatewayCore({
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return { tenantId: 'tenant_a', keyId: 'key_a' };
      },
    },
    storage: new MemoryStorage(),
    resolveRegistration: async () => ({
      ...registration(events),
      canonicalizeEffect() {
        events.push('canonicalize');
        return canonicalEffect;
      },
    }),
    admissionPolicy: {
      async authorizeRequest() {
        admissionCalls += 1;
      },
      async authorizeProviderAttempt() {
        providerAdmissionCalls += 1;
      },
      async reserveProtectedOperation() {
        reserveCalls += 1;
      },
    },
  });

  await assert.rejects(
    core.execute({
      authorization: 'Bearer once_test_a',
      body: { ...body(), effect_hash: wrongHash },
    }),
    (error) => error instanceof HostedGatewayError && error.code === 'effect_hash_mismatch',
  );
  assert.equal(admissionCalls, 0);
  assert.equal(providerAdmissionCalls, 0);
  assert.equal(reserveCalls, 0);
  assert.deepEqual(events, ['authenticate', 'canonicalize']);
});

test('deterministic provider preflight failure never reserves a logical-operation meter unit', async () => {
  const events = [];
  let reserveCalls = 0;
  const core = new HostedGatewayCore({
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return { tenantId: 'tenant_a', keyId: 'key_a' };
      },
    },
    storage: new MemoryStorage(),
    resolveRegistration: async () => registration(events, {
      preflightError: new HostedGatewayError('provider_credentials_unavailable', 503),
    }),
    admissionPolicy: {
      async authorizeRequest() {
        events.push('request_admission');
        return { protection: 'PROTECT', rate: { remaining: 119 } };
      },
      async authorizeProviderAttempt() {
        events.push('provider_attempt_admission');
        return { protection: 'PROTECT', plan: 'pro' };
      },
      async reserveProtectedOperation() {
        reserveCalls += 1;
      },
    },
  });

  await assert.rejects(
    core.execute({ authorization: 'Bearer once_test_a', body: body() }),
    (error) => error instanceof HostedGatewayError && error.code === 'provider_credentials_unavailable',
  );
  assert.deepEqual(events, [
    'authenticate',
    'canonicalize',
    'request_admission',
    'provider_attempt_admission',
    'adapter_construct',
    'provider_preflight',
  ]);
  assert.equal(reserveCalls, 0);
});

test('normal effect drift remains semantic CONFLICT and skips provider-attempt admission on the conflicting retry', async () => {
  const events = [];
  let providerAdmissionCalls = 0;
  let reserveCalls = 0;
  const policy = {
    async authorizeRequest() {
      events.push('request_admission');
      return { protection: 'PROTECT' };
    },
    async authorizeProviderAttempt() {
      events.push('provider_attempt_admission');
      providerAdmissionCalls += 1;
      return { protection: 'PROTECT', plan: 'pro' };
    },
    async reserveProtectedOperation() {
      events.push('meter_reserve');
      reserveCalls += 1;
      return { metered: reserveCalls === 1 };
    },
  };
  const core = new HostedGatewayCore({
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return { tenantId: 'tenant_a', keyId: 'key_a' };
      },
    },
    storage: new MemoryStorage(),
    resolveRegistration: async () => registration(events),
    admissionPolicy: policy,
  });

  const first = await core.execute({ authorization: 'Bearer once_test_a', body: body(100) });
  assert.equal(first.decision, 'EXECUTE');
  const conflict = await core.execute({ authorization: 'Bearer once_test_a', body: body(200) });
  assert.equal(conflict.decision, 'CONFLICT');
  assert.equal(conflict.state, 'CONFIRMED');
  assert.equal(providerAdmissionCalls, 1);
  assert.equal(reserveCalls, 1);
  assert.equal(events.filter((event) => event === 'provider_execute').length, 1);
});

test('confirmed replay remains available when later provider-attempt admission would deny', async () => {
  const events = [];
  let denyProviderAttempts = false;
  let providerAdmissionCalls = 0;
  const policy = {
    async authorizeRequest() {
      events.push('request_admission');
      return { protection: 'PROTECT' };
    },
    async authorizeProviderAttempt() {
      providerAdmissionCalls += 1;
      events.push('provider_attempt_admission');
      if (denyProviderAttempts) throw new HostedGatewayError('entitlement_inactive', 403);
      return { protection: 'PROTECT', plan: 'pro' };
    },
    async reserveProtectedOperation() {
      events.push('meter_reserve');
      return { metered: true, used: 1, period: '2026-09' };
    },
  };
  const core = new HostedGatewayCore({
    authenticator: {
      async authenticate() {
        events.push('authenticate');
        return { tenantId: 'tenant_a', keyId: 'key_a' };
      },
    },
    storage: new MemoryStorage(),
    resolveRegistration: async () => registration(events),
    admissionPolicy: policy,
  });

  const first = await core.execute({ authorization: 'Bearer once_test_a', body: body() });
  assert.equal(first.decision, 'EXECUTE');
  denyProviderAttempts = true;
  const replay = await core.execute({ authorization: 'Bearer once_test_a', body: body() });
  assert.equal(replay.decision, 'REPLAY_CONFIRMED');
  assert.equal(providerAdmissionCalls, 1);
  assert.equal(events.filter((event) => event === 'provider_execute').length, 1);
});

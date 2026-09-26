import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleStagingHostedGatewayRequest,
  STAGING_HOSTED_EXECUTE_PATH,
} from '../src/hosted-staging-execute.mjs';
import {
  handleHostedTenantInternalRequest,
  handleStagingHostedTenantAdminRequest,
  STAGING_HOSTED_TENANT_ADMIN_PATH,
} from '../src/hosted-staging-tenant-admin.mjs';
import {
  createStagingStripeFetch,
  STAGING_LOST_ACK_OPERATION_PREFIX,
} from '../src/hosted-staging-stripe-fault.mjs';
import { storage } from './harness.mjs';

function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('staging hosted execute bridge is absent unless explicitly enabled', async () => {
  const response = await handleStagingHostedGatewayRequest({
    request: jsonRequest(`https://stage.test${STAGING_HOSTED_EXECUTE_PATH}`, { operation_id: 'x' }),
    env: {},
    getDurableStub: async () => { throw new Error('must not run'); },
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'not_found');
});

test('staging hosted execute bridge forwards only the hosted transport headers and body', async () => {
  let forwarded;
  const stub = {
    async fetch(request) {
      forwarded = request;
      return new Response(JSON.stringify({ decision: 'BLOCK_UNKNOWN' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-internal-secret': 'must-not-pass' },
      });
    },
  };
  const response = await handleStagingHostedGatewayRequest({
    request: jsonRequest(
      `https://stage.test${STAGING_HOSTED_EXECUTE_PATH}`,
      { operation_id: 'stage-op' },
      { authorization: 'Bearer once_stage_exampleexampleexampleexample' },
    ),
    env: { ONCE_HOSTED_EXECUTE_ENABLED: 'staging' },
    getDurableStub: async () => stub,
  });

  assert.equal(response.status, 200);
  assert.equal(new URL(forwarded.url).hostname, 'q18.internal');
  assert.equal(forwarded.headers.get('authorization'), 'Bearer once_stage_exampleexampleexampleexample');
  assert.equal(forwarded.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('x-internal-secret'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('staging tenant admin is absent unless enabled and requires the admin bearer token', async () => {
  const disabled = await handleStagingHostedTenantAdminRequest({
    request: jsonRequest(`https://stage.test${STAGING_HOSTED_TENANT_ADMIN_PATH}`, {
      tenant_id: 'tenant_stage',
      stage_key: 'once_stage_abcdefghijklmnopqrstuvwxyz1234567890',
    }),
    env: {},
    getDurableStub: async () => { throw new Error('must not run'); },
  });
  assert.equal(disabled.status, 404);

  const unauthorized = await handleStagingHostedTenantAdminRequest({
    request: jsonRequest(`https://stage.test${STAGING_HOSTED_TENANT_ADMIN_PATH}`, {
      tenant_id: 'tenant_stage',
      stage_key: 'once_stage_abcdefghijklmnopqrstuvwxyz1234567890',
    }),
    env: {
      ONCE_HOSTED_CREDENTIAL_ADMIN_ENABLED: 'staging',
      ONCE_HOSTED_CREDENTIAL_ADMIN_TOKEN: 'once_admin_stage_abcdefghijklmnopqrstuvwxyz1234567890',
    },
    getDurableStub: async () => { throw new Error('must not run'); },
  });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error, 'invalid_admin_token');
});

test('internal tenant bootstrap stores only a hash of the staging API key', async () => {
  const store = storage();
  try {
    store.sql.exec(`
      CREATE TABLE api_keys (
        key_id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        customer_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      )
    `);

    const rawKey = 'once_stage_abcdefghijklmnopqrstuvwxyz1234567890';
    const response = await handleHostedTenantInternalRequest({
      request: jsonRequest('https://q18.internal/__once/hosted/v1/tenants', {
        tenant_id: 'tenant_stage_hash_only',
        stage_key: rawKey,
      }),
      ctx: { storage: store },
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.credentials, 'hash_only');
    assert.doesNotMatch(JSON.stringify(body), /once_stage_/);

    const row = store.sql.exec(
      'SELECT key_hash, customer_id FROM api_keys WHERE customer_id = ?',
      'tenant_stage_hash_only',
    )[0];
    assert.equal(row.customer_id, 'tenant_stage_hash_only');
    assert.match(row.key_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(row.key_hash, rawKey);
  } finally {
    store.db.close();
  }
});

test('staging Stripe fault injector discards only a successful proof refund acknowledgement', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: 're_test' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const injectedFetch = createStagingStripeFetch({
    env: { ONCE_HOSTED_STAGING_FAULT_INJECTION: 'lost_ack' },
    fetchImpl: fakeFetch,
  });

  const body = new URLSearchParams();
  body.set('metadata[once_operation_id]', `${STAGING_LOST_ACK_OPERATION_PREFIX}123`);
  await assert.rejects(
    injectedFetch('https://api.stripe.com/v1/refunds', { method: 'POST', body }),
    /once_staging_injected_lost_ack_after_provider_commit/,
  );
  assert.equal(calls, 1);

  const normalBody = new URLSearchParams();
  normalBody.set('metadata[once_operation_id]', 'ordinary-operation');
  const response = await injectedFetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    body: normalBody,
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test('staging Stripe fault injector never converts a failed provider response into a lost acknowledgement', async () => {
  const injectedFetch = createStagingStripeFetch({
    env: { ONCE_HOSTED_STAGING_FAULT_INJECTION: 'lost_ack' },
    fetchImpl: async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const body = new URLSearchParams();
  body.set('metadata[once_operation_id]', `${STAGING_LOST_ACK_OPERATION_PREFIX}bad`);
  const response = await injectedFetch('https://api.stripe.com/v1/refunds', { method: 'POST', body });
  assert.equal(response.status, 400);
});

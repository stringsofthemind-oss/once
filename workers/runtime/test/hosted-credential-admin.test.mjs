import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleHostedCredentialInternalRequest,
  handleStagingHostedCredentialAdminRequest,
  INTERNAL_HOSTED_CREDENTIAL_ADMIN_PATH,
  STAGING_HOSTED_CREDENTIAL_ADMIN_PATH,
} from '../src/hosted-credential-admin.mjs';

const ADMIN_TOKEN = 'once_admin_stage_0123456789abcdef0123456789abcdef';

function adminRequest(body, token = ADMIN_TOKEN) {
  return new Request(`https://stage.example${STAGING_HOSTED_CREDENTIAL_ADMIN_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function internalRequest(body) {
  return new Request(`https://q18.internal${INTERNAL_HOSTED_CREDENTIAL_ADMIN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('staging credential route is indistinguishable from absent unless explicitly enabled', async () => {
  let stubLookups = 0;
  const response = await handleStagingHostedCredentialAdminRequest({
    request: adminRequest({ action: 'rotate', tenant_id: 'tenant_a', secret_key: 'sk_test_fixture' }),
    env: {},
    getDurableStub: async () => {
      stubLookups += 1;
      throw new Error('must not resolve durable object');
    },
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'not_found');
  assert.equal(stubLookups, 0);
});

test('enabled staging route fails closed when admin token configuration is unsafe', async () => {
  const response = await handleStagingHostedCredentialAdminRequest({
    request: adminRequest({ action: 'disable', tenant_id: 'tenant_a' }),
    env: {
      ONCE_HOSTED_CREDENTIAL_ADMIN_ENABLED: 'staging',
      ONCE_HOSTED_CREDENTIAL_ADMIN_TOKEN: 'too-short',
    },
    getDurableStub: async () => {
      throw new Error('must not resolve durable object');
    },
  });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'credential_admin_unavailable');
});

test('enabled staging route requires the configured staging admin bearer token', async () => {
  const response = await handleStagingHostedCredentialAdminRequest({
    request: adminRequest({ action: 'disable', tenant_id: 'tenant_a' }, 'once_admin_stage_wrong_wrong_wrong_wrong'),
    env: {
      ONCE_HOSTED_CREDENTIAL_ADMIN_ENABLED: 'staging',
      ONCE_HOSTED_CREDENTIAL_ADMIN_TOKEN: ADMIN_TOKEN,
    },
    getDurableStub: async () => {
      throw new Error('must not resolve durable object');
    },
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'invalid_admin_token');
});

test('staging rotate forwards a test secret internally but allowlists the outward response', async () => {
  const secretKey = 'sk_test_super_secret_fixture_value';
  let forwardedBody;
  const response = await handleStagingHostedCredentialAdminRequest({
    request: adminRequest({
      action: 'rotate',
      tenant_id: 'tenant_a',
      secret_key: secretKey,
    }),
    env: {
      ONCE_HOSTED_CREDENTIAL_ADMIN_ENABLED: 'staging',
      ONCE_HOSTED_CREDENTIAL_ADMIN_TOKEN: ADMIN_TOKEN,
    },
    getDurableStub: async () => ({
      async fetch(request) {
        forwardedBody = await request.json();
        return Response.json({
          ok: true,
          action: 'rotate',
          tenant_id: 'tenant_a',
          provider: 'stripe',
          provider_action: 'refund.create',
          credentials: 'stored_encrypted',
          version_id: 'hpc_fixture',
          secret_key: secretKey,
          internal_debug: 'must_not_escape',
        });
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(forwardedBody.secret_key, secretKey);
  assert.equal(forwardedBody.tenant_id, 'tenant_a');
  const text = await response.text();
  assert.doesNotMatch(text, /sk_test_super_secret_fixture_value/);
  assert.doesNotMatch(text, /internal_debug|must_not_escape/);
  assert.match(text, /stored_encrypted/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('staging route rejects live-looking Stripe secrets before durable object access', async () => {
  let stubLookups = 0;
  const response = await handleStagingHostedCredentialAdminRequest({
    request: adminRequest({
      action: 'rotate',
      tenant_id: 'tenant_a',
      secret_key: 'sk_live_never_allowed',
    }),
    env: {
      ONCE_HOSTED_CREDENTIAL_ADMIN_ENABLED: 'staging',
      ONCE_HOSTED_CREDENTIAL_ADMIN_TOKEN: ADMIN_TOKEN,
    },
    getDurableStub: async () => {
      stubLookups += 1;
      throw new Error('must not resolve durable object');
    },
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'stripe_test_secret_required');
  assert.equal(stubLookups, 0);
});

test('internal credential route refuses provisioning for an unknown tenant', async () => {
  let rotateCalls = 0;
  const response = await handleHostedCredentialInternalRequest({
    request: internalRequest({
      action: 'rotate',
      tenant_id: 'missing_tenant',
      secret_key: 'sk_test_fixture',
    }),
    tenantExists: async () => false,
    credentialStore: {
      async rotateStripeRefundSecret() {
        rotateCalls += 1;
      },
      disableStripeRefundSecret() {
        return false;
      },
    },
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'tenant_not_found');
  assert.equal(rotateCalls, 0);
});

test('internal rotate stores the tenant test credential and returns only safe metadata', async () => {
  const secretKey = 'sk_test_internal_fixture';
  let observed;
  const response = await handleHostedCredentialInternalRequest({
    request: internalRequest({
      action: 'rotate',
      tenant_id: 'tenant_a',
      secret_key: secretKey,
    }),
    tenantExists: async (tenantId) => tenantId === 'tenant_a',
    credentialStore: {
      async rotateStripeRefundSecret(input) {
        observed = input;
        return {
          created: true,
          rotated: false,
          provider: 'stripe',
          action: 'refund.create',
          versionId: 'hpc_0123456789abcdef0123456789abcdef',
          credentials: 'stored_encrypted',
        };
      },
      disableStripeRefundSecret() {
        return false;
      },
    },
  });

  assert.deepEqual(observed, { tenantId: 'tenant_a', secretKey });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /sk_test_internal_fixture/);
  const body = JSON.parse(text);
  assert.equal(body.credentials, 'stored_encrypted');
  assert.equal(body.provider, 'stripe');
  assert.equal(body.provider_action, 'refund.create');
});

test('internal disable revokes the active alias without returning credential material', async () => {
  let disabledTenant = null;
  const response = await handleHostedCredentialInternalRequest({
    request: internalRequest({ action: 'disable', tenant_id: 'tenant_a' }),
    tenantExists: async () => true,
    credentialStore: {
      async rotateStripeRefundSecret() {
        throw new Error('must not rotate');
      },
      disableStripeRefundSecret({ tenantId }) {
        disabledTenant = tenantId;
        return true;
      },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(disabledTenant, 'tenant_a');
  assert.deepEqual(await response.json(), {
    ok: true,
    action: 'disable',
    tenant_id: 'tenant_a',
    provider: 'stripe',
    provider_action: 'refund.create',
    disabled: true,
  });
});

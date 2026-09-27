import test from 'node:test';
import assert from 'node:assert/strict';

import {
  maybeHandlePublicHostedGatewayRequest,
  PUBLIC_HOSTED_ADMISSION_VALUE,
  PUBLIC_HOSTED_EXECUTE_PATH,
  PUBLIC_HOSTED_EXECUTE_PREVIEW_VALUE,
} from '../src/hosted-public-execute.mjs';
import { INTERNAL_HOSTED_EXECUTE_PATH } from '../src/hosted-gateway-transport.mjs';

function executeRequest({
  method = 'POST',
  body = '{"operation_id":"op_1"}',
  headers = {},
  path = PUBLIC_HOSTED_EXECUTE_PATH,
} = {}) {
  const init = {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer once_test_fixture',
      ...headers,
    },
  };
  if (method !== 'GET' && method !== 'HEAD') init.body = body;
  return new Request(`https://onceexec.com${path}`, init);
}

function enabledEnv() {
  return {
    ONCE_HOSTED_PUBLIC_EXECUTE_ENABLED: PUBLIC_HOSTED_EXECUTE_PREVIEW_VALUE,
    ONCE_HOSTED_ADMISSION_ENABLED: PUBLIC_HOSTED_ADMISSION_VALUE,
  };
}

test('public hosted bridge returns null when preview gate is absent so legacy /v1/execute can fall through unchanged', async () => {
  let stubCalls = 0;
  const response = await maybeHandlePublicHostedGatewayRequest({
    request: executeRequest(),
    env: {},
    getDurableStub: async () => {
      stubCalls += 1;
      throw new Error('must not resolve durable object');
    },
  });

  assert.equal(response, null);
  assert.equal(stubCalls, 0);
});

test('public hosted bridge ignores unrelated paths even when preview is enabled', async () => {
  let stubCalls = 0;
  const response = await maybeHandlePublicHostedGatewayRequest({
    request: executeRequest({ path: '/v1/truth/op_1' }),
    env: enabledEnv(),
    getDurableStub: async () => {
      stubCalls += 1;
      throw new Error('must not resolve durable object');
    },
  });

  assert.equal(response, null);
  assert.equal(stubCalls, 0);
});

test('public hosted preview fails closed if Phase 12D admission is not enabled', async () => {
  let stubCalls = 0;
  const response = await maybeHandlePublicHostedGatewayRequest({
    request: executeRequest(),
    env: {
      ONCE_HOSTED_PUBLIC_EXECUTE_ENABLED: PUBLIC_HOSTED_EXECUTE_PREVIEW_VALUE,
    },
    getDurableStub: async () => {
      stubCalls += 1;
      throw new Error('must not resolve durable object');
    },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'hosted_gateway_unavailable' });
  assert.equal(stubCalls, 0);
});

test('enabled public hosted bridge is POST-only before durable object access', async () => {
  let stubCalls = 0;
  const response = await maybeHandlePublicHostedGatewayRequest({
    request: executeRequest({ method: 'GET' }),
    env: enabledEnv(),
    getDurableStub: async () => {
      stubCalls += 1;
      throw new Error('must not resolve durable object');
    },
  });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
  assert.equal((await response.json()).error, 'method_not_allowed');
  assert.equal(stubCalls, 0);
});

test('enabled public hosted bridge rejects declared and actual oversized bodies before durable object access', async () => {
  let stubCalls = 0;

  const declared = await maybeHandlePublicHostedGatewayRequest({
    request: executeRequest({ headers: { 'content-length': '65' } }),
    env: enabledEnv(),
    maxBodyBytes: 64,
    getDurableStub: async () => {
      stubCalls += 1;
      throw new Error('must not resolve durable object');
    },
  });
  assert.equal(declared.status, 413);
  assert.equal((await declared.json()).error, 'request_too_large');

  const actual = await maybeHandlePublicHostedGatewayRequest({
    request: executeRequest({ body: 'x'.repeat(65) }),
    env: enabledEnv(),
    maxBodyBytes: 64,
    getDurableStub: async () => {
      stubCalls += 1;
      throw new Error('must not resolve durable object');
    },
  });
  assert.equal(actual.status, 413);
  assert.equal((await actual.json()).error, 'request_too_large');
  assert.equal(stubCalls, 0);
});

test('enabled public hosted bridge forwards only reviewed request transport fields to the internal hosted endpoint', async () => {
  let observed = null;
  const requestBody = JSON.stringify({
    operation_id: 'op_public_preview',
    target: { provider: 'stripe', action: 'refund.create' },
    payload: { payment_intent: 'pi_fixture', amount: 100 },
  });

  const response = await maybeHandlePublicHostedGatewayRequest({
    request: executeRequest({
      body: requestBody,
      headers: {
        'x-secret-debug': 'must_not_forward',
        cookie: 'must_not_forward',
      },
    }),
    env: enabledEnv(),
    getDurableStub: async () => ({
      async fetch(request) {
        observed = {
          url: request.url,
          method: request.method,
          authorization: request.headers.get('authorization'),
          contentType: request.headers.get('content-type'),
          contentLength: request.headers.get('content-length'),
          secretDebug: request.headers.get('x-secret-debug'),
          cookie: request.headers.get('cookie'),
          body: await request.text(),
        };
        return Response.json({ decision: 'EXECUTE', state: 'CONFIRMED' });
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(observed.url, `https://q18.internal${INTERNAL_HOSTED_EXECUTE_PATH}`);
  assert.equal(observed.method, 'POST');
  assert.equal(observed.authorization, 'Bearer once_test_fixture');
  assert.equal(observed.contentType, 'application/json');
  assert.equal(Number(observed.contentLength), new TextEncoder().encode(requestBody).byteLength);
  assert.equal(observed.secretDebug, null);
  assert.equal(observed.cookie, null);
  assert.equal(observed.body, requestBody);
});

test('public hosted response forwards only reviewed hosted operational headers', async () => {
  const response = await maybeHandlePublicHostedGatewayRequest({
    request: executeRequest(),
    env: enabledEnv(),
    getDurableStub: async () => ({
      async fetch() {
        return new Response(JSON.stringify({ decision: 'REPLAY_CONFIRMED' }), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'x-once-rate-limit-limit': '120',
            'x-once-rate-limit-remaining': '119',
            'x-once-usage-limit': '100000',
            'x-once-usage-used': '7',
            'x-once-usage-period': '2026-09',
            'x-once-usage-metered': 'false',
            'x-internal-tenant-id': 'must_not_escape',
            'x-provider-debug': 'must_not_escape',
            'set-cookie': 'must_not_escape=true',
          },
        });
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-once-rate-limit-limit'), '120');
  assert.equal(response.headers.get('x-once-rate-limit-remaining'), '119');
  assert.equal(response.headers.get('x-once-usage-limit'), '100000');
  assert.equal(response.headers.get('x-once-usage-used'), '7');
  assert.equal(response.headers.get('x-once-usage-period'), '2026-09');
  assert.equal(response.headers.get('x-once-usage-metered'), 'false');
  assert.equal(response.headers.get('x-internal-tenant-id'), null);
  assert.equal(response.headers.get('x-provider-debug'), null);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('public hosted bridge maps durable object resolution and fetch failures to opaque 503', async () => {
  const resolutionFailure = await maybeHandlePublicHostedGatewayRequest({
    request: executeRequest(),
    env: enabledEnv(),
    getDurableStub: async () => {
      throw new Error('account or routing detail must not escape');
    },
  });
  assert.equal(resolutionFailure.status, 503);
  assert.deepEqual(await resolutionFailure.json(), { error: 'hosted_gateway_unavailable' });

  const fetchFailure = await maybeHandlePublicHostedGatewayRequest({
    request: executeRequest(),
    env: enabledEnv(),
    getDurableStub: async () => ({
      async fetch() {
        throw new Error('durable object detail must not escape');
      },
    }),
  });
  assert.equal(fetchFailure.status, 503);
  assert.deepEqual(await fetchFailure.json(), { error: 'hosted_gateway_unavailable' });
});

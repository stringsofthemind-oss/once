import {
  INTERNAL_HOSTED_EXECUTE_HOST,
  INTERNAL_HOSTED_EXECUTE_PATH,
} from './hosted-gateway-transport.mjs';

export const STAGING_HOSTED_EXECUTE_PATH = '/__once/staging/hosted/v1/execute';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function copyResponseHeaders(response) {
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  const contentType = response.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  return headers;
}

/**
 * Staging-only public bridge into the internal hosted execute transport.
 *
 * The bridge performs no tenant interpretation itself. It forwards only the
 * small transport header set needed by HostedGatewayCore, and the Durable
 * Object remains authoritative for API-key authentication, effect binding,
 * durable state, provider execution and reconciliation.
 */
export async function handleStagingHostedGatewayRequest({
  request,
  env,
  getDurableStub,
}) {
  if (String(env?.ONCE_HOSTED_EXECUTE_ENABLED || '') !== 'staging') {
    return json({ error: 'not_found' }, 404);
  }

  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  let body;
  try {
    body = await request.arrayBuffer();
  } catch {
    return json({ error: 'request_body_unreadable' }, 400);
  }

  let stub;
  try {
    stub = await getDurableStub();
  } catch {
    return json({ error: 'hosted_gateway_unavailable' }, 503);
  }

  const headers = new Headers();
  for (const name of ['authorization', 'content-type', 'content-length']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    const response = await stub.fetch(
      new Request(
        `https://${INTERNAL_HOSTED_EXECUTE_HOST}${INTERNAL_HOSTED_EXECUTE_PATH}`,
        {
          method: 'POST',
          headers,
          body,
        },
      ),
    );

    return new Response(response.body, {
      status: response.status,
      headers: copyResponseHeaders(response),
    });
  } catch {
    return json({ error: 'hosted_gateway_unavailable' }, 503);
  }
}

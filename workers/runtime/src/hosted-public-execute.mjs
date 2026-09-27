import {
  HOSTED_GATEWAY_MAX_BODY_BYTES,
  INTERNAL_HOSTED_EXECUTE_HOST,
  INTERNAL_HOSTED_EXECUTE_PATH,
} from './hosted-gateway-transport.mjs';

export const PUBLIC_HOSTED_EXECUTE_PATH = '/v1/execute';
export const PUBLIC_HOSTED_EXECUTE_PREVIEW_VALUE = 'phase12d-preview';
export const PUBLIC_HOSTED_ADMISSION_VALUE = 'phase12d';
export const PUBLIC_HOSTED_ENTITLEMENT_FRESHNESS_VALUE = 'phase12d';
export const PUBLIC_HOSTED_ENTITLEMENT_ORDERING_VALUE = 'phase12d';

const RESPONSE_HEADER_ALLOWLIST = Object.freeze([
  'content-type',
  'x-once-rate-limit-limit',
  'x-once-rate-limit-remaining',
  'x-once-usage-limit',
  'x-once-usage-used',
  'x-once-usage-period',
  'x-once-usage-metered',
]);

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function copyResponseHeaders(response) {
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function reviewedHostedSafetyStackEnabled(env) {
  return (
    String(env.ONCE_HOSTED_ADMISSION_ENABLED || '') === PUBLIC_HOSTED_ADMISSION_VALUE &&
    String(env.ONCE_HOSTED_ENTITLEMENT_FRESHNESS_ENABLED || '') ===
      PUBLIC_HOSTED_ENTITLEMENT_FRESHNESS_VALUE &&
    String(env.ONCE_HOSTED_ENTITLEMENT_ORDERING_ENABLED || '') ===
      PUBLIC_HOSTED_ENTITLEMENT_ORDERING_VALUE
  );
}

/**
 * Approval-gated public bridge for the reviewed hosted execute transport.
 *
 * IMPORTANT MIGRATION PROPERTY:
 * When the exact preview gate is absent, this function returns null rather than
 * producing a response. The caller must then fall through to the existing
 * runtime route. That means simply merging this code cannot cut production
 * `/v1/execute` traffic over to the hosted gateway.
 *
 * The public preview is intentionally stricter than the internal/staging hosted
 * path: enabling it requires the reviewed Phase 12D admission, entitlement
 * freshness and entitlement-ordering gates together. Any partial configuration
 * fails closed before Durable Object access. This prevents public provider
 * attempts from relying on active-looking subscription state whose freshness or
 * delivery ordering has not been placed under the Phase 12D controls.
 *
 * The bridge performs transport-only work. Authentication, tenant scope,
 * effect binding, durable state, admission/metering, reconciliation and
 * provider execution remain inside the Durable Object hosted gateway.
 */
export async function maybeHandlePublicHostedGatewayRequest({
  request,
  env,
  getDurableStub,
  maxBodyBytes = HOSTED_GATEWAY_MAX_BODY_BYTES,
}) {
  if (!request || typeof request.method !== 'string') {
    throw new TypeError('request is required');
  }
  if (!env || typeof env !== 'object') {
    throw new TypeError('env is required');
  }
  if (typeof getDurableStub !== 'function') {
    throw new TypeError('getDurableStub must be a function');
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError('maxBodyBytes must be a positive integer');
  }

  const url = new URL(request.url);
  if (url.pathname !== PUBLIC_HOSTED_EXECUTE_PATH) return null;

  if (
    String(env.ONCE_HOSTED_PUBLIC_EXECUTE_ENABLED || '') !==
    PUBLIC_HOSTED_EXECUTE_PREVIEW_VALUE
  ) {
    // Preserve the existing /v1/execute path exactly until a separate
    // environment cutover is explicitly approved.
    return null;
  }

  if (!reviewedHostedSafetyStackEnabled(env)) {
    return json({ error: 'hosted_gateway_unavailable' }, 503);
  }

  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed', allowed: ['POST'] }, 405, {
      allow: 'POST',
    });
  }

  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return json({ error: 'request_too_large' }, 413);
  }

  let body;
  try {
    body = await request.arrayBuffer();
  } catch {
    return json({ error: 'request_body_unreadable' }, 400);
  }
  if (body.byteLength > maxBodyBytes) {
    return json({ error: 'request_too_large' }, 413);
  }

  let stub;
  try {
    stub = await getDurableStub();
  } catch {
    return json({ error: 'hosted_gateway_unavailable' }, 503);
  }

  const forwardedHeaders = new Headers();
  const authorization = request.headers.get('authorization');
  const contentType = request.headers.get('content-type');
  if (authorization) forwardedHeaders.set('authorization', authorization);
  if (contentType) forwardedHeaders.set('content-type', contentType);
  forwardedHeaders.set('content-length', String(body.byteLength));

  let response;
  try {
    response = await stub.fetch(
      new Request(
        `https://${INTERNAL_HOSTED_EXECUTE_HOST}${INTERNAL_HOSTED_EXECUTE_PATH}`,
        {
          method: 'POST',
          headers: forwardedHeaders,
          body,
        },
      ),
    );
  } catch {
    return json({ error: 'hosted_gateway_unavailable' }, 503);
  }

  return new Response(response.body, {
    status: response.status,
    headers: copyResponseHeaders(response),
  });
}

import { HostedGatewayError } from '../../gateway/src/hosted-gateway-core.js';

export const INTERNAL_HOSTED_EXECUTE_PATH = '/__once/hosted/v1/execute';
export const INTERNAL_HOSTED_EXECUTE_HOST = 'q18.internal';
export const HOSTED_GATEWAY_MAX_BODY_BYTES = 64 * 1024;

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

function requestError(code, status, extra = {}) {
  return json({ error: code, ...extra }, status);
}

async function readJsonBody(request, maxBodyBytes) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new HostedGatewayError('request_too_large', 413);
  }

  const contentType = String(request.headers.get('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    throw new HostedGatewayError('unsupported_media_type', 415);
  }

  let bytes;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    throw new HostedGatewayError('request_body_unreadable', 400);
  }

  if (bytes.byteLength > maxBodyBytes) {
    throw new HostedGatewayError('request_too_large', 413);
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HostedGatewayError('invalid_json', 400);
  }
}

function publicResult(result) {
  const body = {
    decision: result.decision,
    state: result.state ?? null,
    operation_id: result.operationId,
    effect_hash: result.effectHash,
    target: {
      provider: result.provider,
      action: result.action,
    },
  };

  if (result.result !== undefined) body.result = result.result;
  if (result.decision === 'CONFLICT') {
    body.error = { code: 'operation_effect_conflict' };
  }

  return body;
}

/**
 * Internal HTTP adapter for the Phase 12C hosted gateway contract.
 *
 * This function performs transport-only work: method/content checks, bounded
 * JSON parsing, stable error mapping and response normalization. Tenant auth,
 * server-owned effect binding, durable UNKNOWN/CONFIRMED state and provider
 * reconciliation remain inside RuntimeHostedGatewayBinding / HostedGatewayCore.
 */
export async function handleHostedGatewayInternalRequest({
  request,
  binding,
  maxBodyBytes = HOSTED_GATEWAY_MAX_BODY_BYTES,
}) {
  if (!request || typeof request.method !== 'string') {
    throw new TypeError('request is required');
  }
  if (!binding?.execute) {
    throw new TypeError('binding must implement execute');
  }

  if (request.method !== 'POST') {
    return requestError('method_not_allowed', 405, { allowed: ['POST'] });
  }

  let body;
  try {
    body = await readJsonBody(request, maxBodyBytes);
    const result = await binding.execute({
      authorization: request.headers.get('authorization'),
      body,
    });
    return json(publicResult(result), 200);
  } catch (error) {
    if (error instanceof HostedGatewayError) {
      const status = Number.isInteger(error.status) ? error.status : 400;
      return requestError(error.code || 'invalid_request', status);
    }

    // Generic failures are deliberately opaque. They can occur after durable
    // UNKNOWN has been written, so the transport must never translate them into
    // evidence that the provider action did not happen.
    return requestError('gateway_internal_error', 500);
  }
}

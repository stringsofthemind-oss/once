const LOST_ACK_PREFIX = 'phase12c-staging-lostack-';

function getOperationIdFromBody(body) {
  try {
    const params = body instanceof URLSearchParams
      ? body
      : new URLSearchParams(typeof body === 'string' ? body : String(body || ''));
    return params.get('metadata[once_operation_id]') || '';
  } catch {
    return '';
  }
}

/**
 * Staging-only transport fault injector used by the live Phase 12C proof.
 *
 * For an explicitly named proof operation, the request is allowed to reach
 * Stripe first. Only after Stripe returns success do we discard that response
 * and throw, reproducing the "provider committed, acknowledgement lost" case.
 * Non-proof operations and non-success responses pass through unchanged.
 */
export function createStagingStripeFetch({ env, fetchImpl = fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  return async (input, init = {}) => {
    const response = await fetchImpl(input, init);

    if (String(env?.ONCE_HOSTED_STAGING_FAULT_INJECTION || '') !== 'lost_ack') {
      return response;
    }

    const url = typeof input === 'string' ? input : String(input?.url || input || '');
    const method = String(init?.method || 'GET').toUpperCase();
    if (method !== 'POST' || !/\/v1\/refunds(?:$|\?)/.test(url)) {
      return response;
    }

    const operationId = getOperationIdFromBody(init?.body);
    if (!operationId.startsWith(LOST_ACK_PREFIX)) {
      return response;
    }

    if (!response.ok) {
      return response;
    }

    throw new Error('once_staging_injected_lost_ack_after_provider_commit');
  };
}

export { LOST_ACK_PREFIX as STAGING_LOST_ACK_OPERATION_PREFIX };

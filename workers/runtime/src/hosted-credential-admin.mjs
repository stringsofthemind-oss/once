export const STAGING_HOSTED_CREDENTIAL_ADMIN_PATH = '/__once/staging/hosted/credentials/stripe-refund';
export const INTERNAL_HOSTED_CREDENTIAL_ADMIN_HOST = 'q18.internal';
export const INTERNAL_HOSTED_CREDENTIAL_ADMIN_PATH = '/__once/hosted/v1/credentials/stripe-refund';

const MAX_ADMIN_BODY_BYTES = 16 * 1024;
const textEncoder = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function sha256Bytes(value) {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', textEncoder.encode(String(value))),
  );
}

async function secureEqual(a, b) {
  const [left, right] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= left[i] ^ right[i];
  }
  return difference === 0;
}

function parseBearer(request) {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer[ \t]+([^ \t]+)$/i);
  return match ? match[1] : null;
}

async function readBoundedJson(request) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return { error: json({ error: 'unsupported_media_type' }, 415) };
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_ADMIN_BODY_BYTES) {
    return { error: json({ error: 'request_too_large' }, 413) };
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return { error: json({ error: 'invalid_request_body' }, 400) };
  }
  if (textEncoder.encode(text).byteLength > MAX_ADMIN_BODY_BYTES) {
    return { error: json({ error: 'request_too_large' }, 413) };
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: json({ error: 'invalid_json' }, 400) };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: json({ error: 'invalid_admin_body' }, 400) };
  }
  return { body };
}

function normalizeTenantId(value) {
  if (typeof value !== 'string') return null;
  const tenantId = value.trim();
  if (!tenantId || textEncoder.encode(tenantId).byteLength > 512) return null;
  return tenantId;
}

function sanitizeInternalAdminResult(body, status) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'credential_admin_unavailable' }, 503);
  }

  if (status < 200 || status >= 300) {
    const allowedErrors = new Set([
      'invalid_tenant_id',
      'tenant_not_found',
      'invalid_credential_action',
      'stripe_test_secret_required',
      'invalid_provider_credential',
      'credential_admin_unavailable',
    ]);
    const error = allowedErrors.has(body.error)
      ? body.error
      : 'credential_admin_unavailable';
    return json({ error }, status >= 400 && status <= 599 ? status : 503);
  }

  if (body.action === 'rotate') {
    return json({
      ok: body.ok === true,
      action: 'rotate',
      tenant_id: String(body.tenant_id || ''),
      provider: 'stripe',
      provider_action: 'refund.create',
      version_id: String(body.version_id || ''),
      credentials: body.credentials === 'stored_encrypted' ? 'stored_encrypted' : 'stored_encrypted',
      created: body.created === true,
      rotated: body.rotated === true,
    }, status);
  }

  if (body.action === 'disable') {
    return json({
      ok: body.ok === true,
      action: 'disable',
      tenant_id: String(body.tenant_id || ''),
      provider: 'stripe',
      provider_action: 'refund.create',
      disabled: body.disabled === true,
    }, status);
  }

  return json({ error: 'credential_admin_unavailable' }, 503);
}

/**
 * Public Worker staging gate. This route is absent unless the exact staging
 * enable flag is configured. The admin token must itself be a staging token;
 * no production/live fallback exists.
 */
export async function handleStagingHostedCredentialAdminRequest({
  request,
  env,
  getDurableStub,
}) {
  if (String(env?.ONCE_HOSTED_CREDENTIAL_ADMIN_ENABLED || '') !== 'staging') {
    return json({ error: 'not_found' }, 404);
  }

  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const configuredToken = String(env?.ONCE_HOSTED_CREDENTIAL_ADMIN_TOKEN || '');
  if (
    !configuredToken.startsWith('once_admin_stage_') ||
    configuredToken.length < 32
  ) {
    return json({ error: 'credential_admin_unavailable' }, 503);
  }

  const presentedToken = parseBearer(request);
  if (!presentedToken || !(await secureEqual(presentedToken, configuredToken))) {
    return json({ error: 'invalid_admin_token' }, 401);
  }

  const parsed = await readBoundedJson(request);
  if (parsed.error) return parsed.error;

  const tenantId = normalizeTenantId(parsed.body.tenant_id);
  if (!tenantId) return json({ error: 'invalid_tenant_id' }, 400);

  const action = String(parsed.body.action || '').trim().toLowerCase();
  if (action !== 'rotate' && action !== 'disable') {
    return json({ error: 'invalid_credential_action' }, 400);
  }

  const forwarded = {
    action,
    tenant_id: tenantId,
  };
  if (action === 'rotate') {
    if (
      typeof parsed.body.secret_key !== 'string' ||
      !parsed.body.secret_key.startsWith('sk_test_') ||
      textEncoder.encode(parsed.body.secret_key).byteLength > 4096
    ) {
      return json({ error: 'stripe_test_secret_required' }, 400);
    }
    forwarded.secret_key = parsed.body.secret_key;
  }

  let stub;
  try {
    stub = await getDurableStub();
  } catch {
    return json({ error: 'credential_admin_unavailable' }, 503);
  }

  try {
    const response = await stub.fetch(
      new Request(
        `https://${INTERNAL_HOSTED_CREDENTIAL_ADMIN_HOST}${INTERNAL_HOSTED_CREDENTIAL_ADMIN_PATH}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(forwarded),
        },
      ),
    );

    let responseBody;
    try {
      responseBody = await response.json();
    } catch {
      return json({ error: 'credential_admin_unavailable' }, 503);
    }
    return sanitizeInternalAdminResult(responseBody, response.status);
  } catch {
    return json({ error: 'credential_admin_unavailable' }, 503);
  }
}

/**
 * Durable Object side of the staging credential admin path. It accepts only the
 * synthetic internal host and never returns plaintext credentials.
 */
export async function handleHostedCredentialInternalRequest({
  request,
  credentialStore,
  tenantExists,
}) {
  const url = new URL(request.url);
  if (
    url.hostname !== INTERNAL_HOSTED_CREDENTIAL_ADMIN_HOST ||
    url.pathname !== INTERNAL_HOSTED_CREDENTIAL_ADMIN_PATH
  ) {
    return json({ error: 'not_found' }, 404);
  }
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const parsed = await readBoundedJson(request);
  if (parsed.error) return parsed.error;
  const tenantId = normalizeTenantId(parsed.body.tenant_id);
  if (!tenantId) return json({ error: 'invalid_tenant_id' }, 400);

  let exists = false;
  try {
    exists = await tenantExists(tenantId);
  } catch {
    return json({ error: 'credential_admin_unavailable' }, 503);
  }
  if (!exists) return json({ error: 'tenant_not_found' }, 404);

  const action = String(parsed.body.action || '').trim().toLowerCase();
  try {
    if (action === 'rotate') {
      const secretKey = parsed.body.secret_key;
      if (typeof secretKey !== 'string' || !secretKey.startsWith('sk_test_')) {
        return json({ error: 'stripe_test_secret_required' }, 400);
      }
      const result = await credentialStore.rotateStripeRefundSecret({
        tenantId,
        secretKey,
      });
      return json({
        ok: true,
        action: 'rotate',
        tenant_id: tenantId,
        provider: result.provider,
        provider_action: result.action,
        version_id: result.versionId,
        credentials: result.credentials,
        created: result.created,
        rotated: result.rotated,
      });
    }

    if (action === 'disable') {
      const disabled = credentialStore.disableStripeRefundSecret({ tenantId });
      return json({
        ok: true,
        action: 'disable',
        tenant_id: tenantId,
        provider: 'stripe',
        provider_action: 'refund.create',
        disabled,
      });
    }
  } catch (error) {
    if (error instanceof TypeError) {
      return json({ error: 'invalid_provider_credential' }, 400);
    }
    return json({ error: 'credential_admin_unavailable' }, 503);
  }

  return json({ error: 'invalid_credential_action' }, 400);
}

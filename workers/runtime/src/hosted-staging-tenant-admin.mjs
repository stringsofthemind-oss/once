export const STAGING_HOSTED_TENANT_ADMIN_PATH = '/__once/staging/hosted/tenants';
export const INTERNAL_HOSTED_TENANT_ADMIN_HOST = 'q18.internal';
export const INTERNAL_HOSTED_TENANT_ADMIN_PATH = '/__once/hosted/v1/tenants';

const MAX_BODY_BYTES = 16 * 1024;
const textEncoder = new TextEncoder();

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

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(String(value)));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function secureEqual(a, b) {
  const [left, right] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

function parseBearer(request) {
  const value = request.headers.get('authorization') || '';
  const match = value.match(/^Bearer[ \t]+([^ \t]+)$/i);
  return match ? match[1] : null;
}

async function readJson(request) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return { error: json({ error: 'unsupported_media_type' }, 415) };
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { error: json({ error: 'request_too_large' }, 413) };
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return { error: json({ error: 'invalid_request_body' }, 400) };
  }
  if (textEncoder.encode(text).byteLength > MAX_BODY_BYTES) {
    return { error: json({ error: 'request_too_large' }, 413) };
  }

  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { error: json({ error: 'invalid_admin_body' }, 400) };
    }
    return { body };
  } catch {
    return { error: json({ error: 'invalid_json' }, 400) };
  }
}

function normalizeTenantId(value) {
  if (typeof value !== 'string') return null;
  const tenantId = value.trim();
  if (!/^[A-Za-z0-9._:-]{3,200}$/.test(tenantId)) return null;
  return tenantId;
}

function normalizeStageApiKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!/^once_stage_[A-Za-z0-9_-]{32,200}$/.test(key)) return null;
  return key;
}

export async function handleStagingHostedTenantAdminRequest({
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
  if (!configuredToken.startsWith('once_admin_stage_') || configuredToken.length < 32) {
    return json({ error: 'tenant_admin_unavailable' }, 503);
  }
  const presentedToken = parseBearer(request);
  if (!presentedToken || !(await secureEqual(presentedToken, configuredToken))) {
    return json({ error: 'invalid_admin_token' }, 401);
  }

  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;
  const tenantId = normalizeTenantId(parsed.body.tenant_id);
  const apiKey = normalizeStageApiKey(parsed.body.stage_key);
  if (!tenantId) return json({ error: 'invalid_tenant_id' }, 400);
  if (!apiKey) return json({ error: 'invalid_stage_key' }, 400);

  let stub;
  try {
    stub = await getDurableStub();
  } catch {
    return json({ error: 'tenant_admin_unavailable' }, 503);
  }

  try {
    const response = await stub.fetch(
      new Request(
        `https://${INTERNAL_HOSTED_TENANT_ADMIN_HOST}${INTERNAL_HOSTED_TENANT_ADMIN_PATH}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenant_id: tenantId, stage_key: apiKey }),
        },
      ),
    );
    let body;
    try {
      body = await response.json();
    } catch {
      return json({ error: 'tenant_admin_unavailable' }, 503);
    }
    if (!response.ok) {
      const allowed = new Set(['tenant_already_exists', 'stage_key_conflict', 'invalid_tenant_id', 'invalid_stage_key']);
      return json({ error: allowed.has(body?.error) ? body.error : 'tenant_admin_unavailable' }, response.status);
    }
    return json({
      ok: body?.ok === true,
      tenant_id: String(body?.tenant_id || ''),
      created: body?.created === true,
      key_id: String(body?.key_id || ''),
      credentials: 'hash_only',
    });
  } catch {
    return json({ error: 'tenant_admin_unavailable' }, 503);
  }
}

export async function handleHostedTenantInternalRequest({ request, ctx }) {
  const url = new URL(request.url);
  if (
    url.hostname !== INTERNAL_HOSTED_TENANT_ADMIN_HOST ||
    url.pathname !== INTERNAL_HOSTED_TENANT_ADMIN_PATH
  ) {
    return json({ error: 'not_found' }, 404);
  }
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;
  const tenantId = normalizeTenantId(parsed.body.tenant_id);
  const apiKey = normalizeStageApiKey(parsed.body.stage_key);
  if (!tenantId) return json({ error: 'invalid_tenant_id' }, 400);
  if (!apiKey) return json({ error: 'invalid_stage_key' }, 400);

  const sql = ctx?.storage?.sql;
  if (!sql?.exec || typeof ctx.storage.transactionSync !== 'function') {
    return json({ error: 'tenant_admin_unavailable' }, 503);
  }

  const activeTenant = [...sql.exec(
    'SELECT key_id FROM api_keys WHERE customer_id = ? AND revoked_at IS NULL LIMIT 1',
    tenantId,
  )][0];
  if (activeTenant) return json({ error: 'tenant_already_exists' }, 409);

  const keyHash = await sha256Hex(apiKey);
  const existingHash = [...sql.exec(
    'SELECT customer_id FROM api_keys WHERE key_hash = ? LIMIT 1',
    keyHash,
  )][0];
  if (existingHash) return json({ error: 'stage_key_conflict' }, 409);

  const keyId = `key_stage_${crypto.randomUUID().replaceAll('-', '')}`;
  const createdAt = new Date().toISOString();
  try {
    ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO api_keys (key_id, key_hash, customer_id, created_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL)`,
        keyId,
        keyHash,
        tenantId,
        createdAt,
      );
    });
    if (typeof ctx.storage.sync === 'function') await ctx.storage.sync();
  } catch {
    return json({ error: 'tenant_admin_unavailable' }, 503);
  }

  return json({
    ok: true,
    tenant_id: tenantId,
    created: true,
    key_id: keyId,
    credentials: 'hash_only',
  }, 201);
}

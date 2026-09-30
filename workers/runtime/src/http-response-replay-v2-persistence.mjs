export const HTTP_RESPONSE_REPLAY_V2_CONTRACT = 'http_response_replay_v2';
export const HTTP_RESPONSE_REPLAY_V2_BODY_LIMIT = 1024 * 1024;
export const HTTP_RESPONSE_REPLAY_V2_HEADERS_LIMIT = 16 * 1024;

const RECEIPT_KEYS = [
  'body_base64',
  'body_length',
  'body_present',
  'contract',
  'headers_entries',
  'redirected',
  'status',
  'status_text',
  'type',
  'url',
];

const SUPPORTED_TYPES = new Set(['basic', 'cors', 'default']);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export class HttpResponseReplayV2PersistenceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'HttpResponseReplayV2PersistenceError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new HttpResponseReplayV2PersistenceError(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value) {
  if (!isPlainObject(value)) {
    fail('invalid_http_response_replay_v2_shape', 'receipt must be a plain object');
  }

  const actual = Object.keys(value).sort();
  if (
    actual.length !== RECEIPT_KEYS.length ||
    actual.some((key, index) => key !== RECEIPT_KEYS[index])
  ) {
    fail(
      'invalid_http_response_replay_v2_shape',
      `receipt must contain exactly: ${RECEIPT_KEYS.join(', ')}`,
    );
  }
}

function requireString(value, label, { allowEmpty = true, maxLength = Infinity } = {}) {
  if (typeof value !== 'string') {
    fail('invalid_http_response_replay_v2_string', `${label} must be a string`);
  }
  if (!allowEmpty && value.length === 0) {
    fail('invalid_http_response_replay_v2_string', `${label} must not be empty`);
  }
  if (value.length > maxLength) {
    fail('http_response_replay_v2_value_too_large', `${label} exceeds its persistence limit`);
  }
  return value;
}

function bytesToCanonicalBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)),
    );
  }
  return btoa(binary);
}

function decodeCanonicalBase64(value) {
  const base64 = requireString(value, 'body_base64');
  let binary;
  try {
    binary = atob(base64);
  }
  catch (error) {
    fail('invalid_http_response_replay_v2_base64', 'body_base64 must be valid base64', error);
  }

  if (btoa(binary) !== base64) {
    fail(
      'invalid_http_response_replay_v2_base64',
      'body_base64 must use canonical base64 encoding',
    );
  }

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function validateStatus(value) {
  if (!Number.isInteger(value) || value < 200 || value > 599) {
    fail(
      'invalid_http_response_replay_v2_status',
      'status must be an integer from 200 through 599',
    );
  }
  return value;
}

function validateStatusText(value, status) {
  const statusText = requireString(value, 'status_text', { maxLength: 1024 });
  try {
    const probe = new Response(null, { status, statusText });
    if (probe.statusText !== statusText) {
      fail(
        'noncanonical_http_response_replay_v2_status_text',
        'status_text must survive native Response normalization unchanged',
      );
    }
  }
  catch (error) {
    if (error instanceof HttpResponseReplayV2PersistenceError) throw error;
    fail(
      'invalid_http_response_replay_v2_status_text',
      'status_text is not valid native Response metadata',
      error,
    );
  }
  return statusText;
}

function validateUrl(value) {
  const url = requireString(value, 'url', { allowEmpty: false, maxLength: 8192 });
  let parsed;
  try {
    parsed = new URL(url);
  }
  catch (error) {
    fail('invalid_http_response_replay_v2_url', 'url must be an absolute HTTP(S) URL', error);
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.toString() !== url
  ) {
    fail(
      'invalid_http_response_replay_v2_url',
      'url must be exact canonical HTTP(S) without credentials or a fragment',
    );
  }
  return url;
}

function validateHeaders(value) {
  if (!Array.isArray(value)) {
    fail('invalid_http_response_replay_v2_headers', 'headers_entries must be an array');
  }

  const entries = value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      fail(
        'invalid_http_response_replay_v2_headers',
        'each headers_entries item must be an exact [name, value] pair',
      );
    }
    const name = requireString(entry[0], 'header name', { allowEmpty: false });
    const headerValue = requireString(entry[1], 'header value');
    if (name !== name.toLowerCase()) {
      fail(
        'noncanonical_http_response_replay_v2_headers',
        'header names must already use native lower-case canonical form',
      );
    }
    return [name, headerValue];
  });

  let canonical;
  try {
    canonical = Array.from(new Headers(entries).entries());
  }
  catch (error) {
    fail(
      'invalid_http_response_replay_v2_headers',
      'headers_entries contains invalid native Headers metadata',
      error,
    );
  }

  if (JSON.stringify(canonical) !== JSON.stringify(entries)) {
    fail(
      'noncanonical_http_response_replay_v2_headers',
      'headers_entries must already match native Headers iteration exactly',
    );
  }

  const encoded = new TextEncoder().encode(JSON.stringify(entries));
  if (encoded.byteLength > HTTP_RESPONSE_REPLAY_V2_HEADERS_LIMIT) {
    fail(
      'http_response_replay_v2_headers_too_large',
      'headers_entries exceeds the durable persistence limit',
    );
  }

  return entries;
}

export function validateHttpResponseReplayV2ForPersistence(value) {
  requireExactKeys(value);

  if (value.contract !== HTTP_RESPONSE_REPLAY_V2_CONTRACT) {
    fail(
      'unsupported_http_response_replay_v2_contract',
      `contract must be exact ${HTTP_RESPONSE_REPLAY_V2_CONTRACT}`,
    );
  }

  const status = validateStatus(value.status);
  const statusText = validateStatusText(value.status_text, status);
  const headersEntries = validateHeaders(value.headers_entries);

  if (typeof value.body_present !== 'boolean') {
    fail(
      'invalid_http_response_replay_v2_body_presence',
      'body_present must be boolean',
    );
  }

  const bytes = decodeCanonicalBase64(value.body_base64);
  if (
    !Number.isSafeInteger(value.body_length) ||
    value.body_length < 0 ||
    value.body_length !== bytes.byteLength
  ) {
    fail(
      'invalid_http_response_replay_v2_body_length',
      'body_length must exactly equal the decoded body byte length',
    );
  }

  if (bytes.byteLength > HTTP_RESPONSE_REPLAY_V2_BODY_LIMIT) {
    fail(
      'http_response_replay_v2_body_too_large',
      'response body exceeds the durable persistence limit',
    );
  }

  if (!value.body_present && bytes.byteLength !== 0) {
    fail(
      'invalid_http_response_replay_v2_body_presence',
      'a null response body cannot carry replay bytes',
    );
  }

  if (NULL_BODY_STATUSES.has(status) && value.body_present) {
    fail(
      'invalid_http_response_replay_v2_body_presence',
      'native null-body statuses cannot carry a replay body',
    );
  }

  const url = validateUrl(value.url);

  if (typeof value.redirected !== 'boolean') {
    fail(
      'invalid_http_response_replay_v2_redirected',
      'redirected must be boolean',
    );
  }

  if (!SUPPORTED_TYPES.has(value.type)) {
    fail(
      'unsupported_http_response_replay_v2_type',
      'type must be exact basic, cors, or default',
    );
  }

  return {
    contract: HTTP_RESPONSE_REPLAY_V2_CONTRACT,
    status,
    status_text: statusText,
    headers_entries: headersEntries.map(([name, headerValue]) => [name, headerValue]),
    body_present: value.body_present,
    body_base64: value.body_base64,
    body_length: value.body_length,
    url,
    redirected: value.redirected,
    type: value.type,
  };
}

/**
 * Capture a replay-v2 receipt without consuming the provider adapter's source
 * Response. The clone is the only body that is read.
 */
export async function captureHttpResponseReplayV2ForProvider(response) {
  if (!(response instanceof Response)) {
    fail(
      'invalid_http_response_replay_v2_source',
      'capture source must be a native Response',
    );
  }
  if (response.bodyUsed) {
    fail(
      'used_http_response_replay_v2_source',
      'capture source body must not already be used',
    );
  }

  let clone;
  try {
    clone = response.clone();
  }
  catch (error) {
    fail(
      'uncloneable_http_response_replay_v2_source',
      'capture source must be cloneable before body consumption',
      error,
    );
  }

  const bodyPresent = clone.body !== null;
  const bytes = bodyPresent
    ? new Uint8Array(await clone.arrayBuffer())
    : new Uint8Array();

  return validateHttpResponseReplayV2ForPersistence({
    contract: HTTP_RESPONSE_REPLAY_V2_CONTRACT,
    status: response.status,
    status_text: response.statusText,
    headers_entries: Array.from(response.headers.entries()),
    body_present: bodyPresent,
    body_base64: bytesToCanonicalBase64(bytes),
    body_length: bytes.byteLength,
    url: response.url,
    redirected: response.redirected,
    type: response.type,
  });
}

function normalizeOperationId(operationId) {
  const value = String(operationId || '').trim();
  if (!value) {
    fail(
      'http_response_replay_v2_operation_id_required',
      'operation_id is required',
    );
  }
  return value;
}

function normalizeRecordedAt(recordedAt) {
  const value = String(recordedAt || '').trim();
  if (!value) {
    fail(
      'http_response_replay_v2_recorded_at_required',
      'recorded_at is required',
    );
  }
  return value;
}

export class HttpResponseReplayV2Store {
  constructor(sql) {
    if (!sql || typeof sql.exec !== 'function') {
      fail(
        'http_response_replay_v2_sql_required',
        'a Durable Object SQL executor is required',
      );
    }
    this.sql = sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS http_response_replays_v2 (
        operation_id TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      )
    `);
  }

  get(operationId) {
    const normalizedOperationId = normalizeOperationId(operationId);
    const row = [
      ...this.sql.exec(
        `
          SELECT receipt_json, recorded_at
          FROM http_response_replays_v2
          WHERE operation_id = ?
          LIMIT 1
        `,
        normalizedOperationId,
      ),
    ][0];

    if (!row) return undefined;

    let parsed;
    try {
      parsed = JSON.parse(String(row.receipt_json));
    }
    catch (error) {
      fail(
        'http_response_replay_v2_corrupt_json',
        'stored replay-v2 receipt is not valid JSON',
        error,
      );
    }

    return {
      operation_id: normalizedOperationId,
      receipt: validateHttpResponseReplayV2ForPersistence(parsed),
      recorded_at: String(row.recorded_at),
    };
  }

  record(
    operationId,
    receipt,
    { recordedAt = new Date().toISOString() } = {},
  ) {
    const normalizedOperationId = normalizeOperationId(operationId);
    const validated = validateHttpResponseReplayV2ForPersistence(receipt);
    const normalizedRecordedAt = normalizeRecordedAt(recordedAt);
    const receiptJson = JSON.stringify(validated);
    const existing = this.get(normalizedOperationId);

    if (existing) {
      if (JSON.stringify(existing.receipt) === receiptJson) return existing;
      fail(
        'http_response_replay_v2_conflict',
        'operation_id already has a different replay-v2 receipt',
      );
    }

    this.sql.exec(
      `
        INSERT INTO http_response_replays_v2 (
          operation_id,
          receipt_json,
          recorded_at
        ) VALUES (?, ?, ?)
      `,
      normalizedOperationId,
      receiptJson,
      normalizedRecordedAt,
    );

    return this.get(normalizedOperationId);
  }
}

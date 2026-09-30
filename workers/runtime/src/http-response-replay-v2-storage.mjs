export const HTTP_RESPONSE_REPLAY_V2_CONTRACT = 'http_response_replay_v2';
export const HTTP_RESPONSE_REPLAY_V2_TABLE = 'http_response_replays_v2';

export const HTTP_RESPONSE_REPLAY_V2_CREATE_SQL = `
CREATE TABLE IF NOT EXISTS http_response_replays_v2 (
  operation_id TEXT PRIMARY KEY,
  contract TEXT NOT NULL,
  status INTEGER NOT NULL,
  status_text TEXT NOT NULL,
  headers_entries_json TEXT NOT NULL,
  body_present INTEGER NOT NULL CHECK(body_present IN (0, 1)),
  body_base64 TEXT NOT NULL,
  body_length INTEGER NOT NULL CHECK(body_length >= 0),
  url TEXT NOT NULL,
  redirected INTEGER NOT NULL CHECK(redirected IN (0, 1)),
  response_type TEXT NOT NULL,
  recorded_at TEXT NOT NULL
)`;

export class HttpResponseReplayV2StorageError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'HttpResponseReplayV2StorageError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new HttpResponseReplayV2StorageError(
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

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) {
    fail('invalid_http_response_replay_v2_storage_shape', `${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      'invalid_http_response_replay_v2_storage_shape',
      `${label} must contain exactly: ${expected.join(', ')}.`,
    );
  }
}

function stringValue(value, label, { allowEmpty = true } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    fail('invalid_http_response_replay_v2_storage_string', `${label} must be a string.`);
  }
  return value;
}

function canonicalBase64(value) {
  const base64 = stringValue(value, 'body_base64');
  let binary;
  try {
    binary = atob(base64);
  } catch (error) {
    fail('invalid_http_response_replay_v2_storage_base64', 'body_base64 must be valid base64.', error);
  }
  if (btoa(binary) !== base64) {
    fail(
      'invalid_http_response_replay_v2_storage_base64',
      'body_base64 must use canonical base64 encoding.',
    );
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function canonicalHeaders(value) {
  if (!Array.isArray(value)) {
    fail('invalid_http_response_replay_v2_storage_headers', 'headers_entries must be an array.');
  }
  const entries = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      fail(
        'invalid_http_response_replay_v2_storage_headers',
        'Each headers_entries item must be an exact [name, value] pair.',
      );
    }
    const name = stringValue(entry[0], 'header name', { allowEmpty: false });
    const headerValue = stringValue(entry[1], 'header value');
    if (name !== name.toLowerCase()) {
      fail(
        'noncanonical_http_response_replay_v2_storage_headers',
        'Header names must already be lowercase canonical form.',
      );
    }
    entries.push([name, headerValue]);
  }

  let normalized;
  try {
    normalized = Array.from(new Headers(entries).entries());
  } catch (error) {
    fail(
      'invalid_http_response_replay_v2_storage_headers',
      'headers_entries contains an invalid header value.',
      error,
    );
  }
  if (JSON.stringify(normalized) !== JSON.stringify(entries)) {
    fail(
      'noncanonical_http_response_replay_v2_storage_headers',
      'headers_entries must already match native Headers iteration.',
    );
  }
  return entries;
}

function canonicalUrl(value) {
  const url = stringValue(value, 'url', { allowEmpty: false });
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    fail('invalid_http_response_replay_v2_storage_url', 'url must be absolute HTTP(S).', error);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.toString() !== url
  ) {
    fail(
      'invalid_http_response_replay_v2_storage_url',
      'url must be canonical HTTP(S) without credentials or a fragment.',
    );
  }
  return url;
}

function normalizeReceipt(receipt) {
  exactKeys(
    receipt,
    [
      'contract',
      'status',
      'status_text',
      'headers_entries',
      'body_present',
      'body_base64',
      'body_length',
      'url',
      'redirected',
      'type',
    ],
    'response replay v2 receipt',
  );

  if (receipt.contract !== HTTP_RESPONSE_REPLAY_V2_CONTRACT) {
    fail(
      'unsupported_http_response_replay_v2_storage_contract',
      `contract must be exact ${HTTP_RESPONSE_REPLAY_V2_CONTRACT}.`,
    );
  }

  if (!Number.isInteger(receipt.status) || receipt.status < 200 || receipt.status > 599) {
    fail('invalid_http_response_replay_v2_storage_status', 'status must be 200 through 599.');
  }

  const statusText = stringValue(receipt.status_text, 'status_text');
  try {
    const probe = new Response(null, { status: receipt.status, statusText });
    if (probe.statusText !== statusText) {
      fail(
        'noncanonical_http_response_replay_v2_storage_status_text',
        'status_text must survive native Response normalization unchanged.',
      );
    }
  } catch (error) {
    if (error instanceof HttpResponseReplayV2StorageError) throw error;
    fail(
      'invalid_http_response_replay_v2_storage_status_text',
      'status_text is not valid Response metadata.',
      error,
    );
  }

  const headersEntries = canonicalHeaders(receipt.headers_entries);
  const headersJson = JSON.stringify(headersEntries);
  if (new TextEncoder().encode(headersJson).byteLength > 16384) {
    fail('http_response_replay_v2_storage_headers_too_large', 'headers_entries exceeds 16 KiB.');
  }

  if (typeof receipt.body_present !== 'boolean') {
    fail('invalid_http_response_replay_v2_storage_body_presence', 'body_present must be boolean.');
  }
  const bytes = canonicalBase64(receipt.body_base64);
  if (
    !Number.isSafeInteger(receipt.body_length) ||
    receipt.body_length < 0 ||
    receipt.body_length !== bytes.byteLength
  ) {
    fail(
      'invalid_http_response_replay_v2_storage_body_length',
      'body_length must equal the decoded body byte length.',
    );
  }
  if (bytes.byteLength > 1048576) {
    fail('http_response_replay_v2_storage_body_too_large', 'response body exceeds 1 MiB.');
  }
  if (!receipt.body_present && bytes.byteLength !== 0) {
    fail(
      'invalid_http_response_replay_v2_storage_body_presence',
      'A null response body cannot carry bytes.',
    );
  }
  if ([204, 205, 304].includes(receipt.status) && receipt.body_present) {
    fail(
      'invalid_http_response_replay_v2_storage_body_presence',
      'Native null-body statuses cannot carry replay bytes.',
    );
  }

  const url = canonicalUrl(receipt.url);
  if (typeof receipt.redirected !== 'boolean') {
    fail('invalid_http_response_replay_v2_storage_redirected', 'redirected must be boolean.');
  }
  if (!['basic', 'cors', 'default'].includes(receipt.type)) {
    fail(
      'unsupported_http_response_replay_v2_storage_type',
      'response type must be basic, cors, or default.',
    );
  }

  return {
    contract: HTTP_RESPONSE_REPLAY_V2_CONTRACT,
    status: receipt.status,
    status_text: statusText,
    headers_entries: headersEntries,
    body_present: receipt.body_present,
    body_base64: receipt.body_base64,
    body_length: receipt.body_length,
    url,
    redirected: receipt.redirected,
    type: receipt.type,
  };
}

export function encodeHttpResponseReplayV2Row(operationId, receipt, recordedAt) {
  const normalizedOperationId = stringValue(operationId, 'operation_id', { allowEmpty: false }).trim();
  if (!normalizedOperationId) {
    fail('http_response_replay_v2_storage_operation_id_required', 'operation_id is required.');
  }
  const normalizedRecordedAt = stringValue(recordedAt, 'recorded_at', { allowEmpty: false }).trim();
  if (!normalizedRecordedAt) {
    fail('http_response_replay_v2_storage_recorded_at_required', 'recorded_at is required.');
  }

  const normalized = normalizeReceipt(receipt);
  return {
    operation_id: normalizedOperationId,
    contract: normalized.contract,
    status: normalized.status,
    status_text: normalized.status_text,
    headers_entries_json: JSON.stringify(normalized.headers_entries),
    body_present: normalized.body_present ? 1 : 0,
    body_base64: normalized.body_base64,
    body_length: normalized.body_length,
    url: normalized.url,
    redirected: normalized.redirected ? 1 : 0,
    response_type: normalized.type,
    recorded_at: normalizedRecordedAt,
  };
}

export function decodeHttpResponseReplayV2Row(row) {
  exactKeys(
    row,
    [
      'operation_id',
      'contract',
      'status',
      'status_text',
      'headers_entries_json',
      'body_present',
      'body_base64',
      'body_length',
      'url',
      'redirected',
      'response_type',
      'recorded_at',
    ],
    'response replay v2 storage row',
  );

  const operationId = stringValue(row.operation_id, 'operation_id', { allowEmpty: false });
  const recordedAt = stringValue(row.recorded_at, 'recorded_at', { allowEmpty: false });
  let headersEntries;
  try {
    headersEntries = JSON.parse(stringValue(row.headers_entries_json, 'headers_entries_json'));
  } catch (error) {
    fail(
      'corrupt_http_response_replay_v2_storage_headers',
      'headers_entries_json must be valid JSON.',
      error,
    );
  }

  if (row.body_present !== 0 && row.body_present !== 1) {
    fail('corrupt_http_response_replay_v2_storage_body_presence', 'body_present must be 0 or 1.');
  }
  if (row.redirected !== 0 && row.redirected !== 1) {
    fail('corrupt_http_response_replay_v2_storage_redirected', 'redirected must be 0 or 1.');
  }

  const receipt = normalizeReceipt({
    contract: row.contract,
    status: row.status,
    status_text: row.status_text,
    headers_entries: headersEntries,
    body_present: row.body_present === 1,
    body_base64: row.body_base64,
    body_length: row.body_length,
    url: row.url,
    redirected: row.redirected === 1,
    type: row.response_type,
  });

  return {
    operation_id: operationId,
    ...receipt,
    recorded_at: recordedAt,
  };
}

function semanticStorageView(row) {
  const decoded = decodeHttpResponseReplayV2Row(row);
  const { operation_id, recorded_at, ...receipt } = decoded;
  return { operation_id, ...receipt };
}

export function assertHttpResponseReplayV2Idempotent(existingRow, candidateRow) {
  const existing = semanticStorageView(existingRow);
  const candidate = semanticStorageView(candidateRow);
  if (JSON.stringify(existing) !== JSON.stringify(candidate)) {
    fail(
      'http_response_replay_v2_storage_conflict',
      'An operation already has a different v2 response replay receipt.',
    );
  }
  return decodeHttpResponseReplayV2Row(existingRow);
}

export function httpResponseReplayV2InsertSql() {
  return `INSERT INTO ${HTTP_RESPONSE_REPLAY_V2_TABLE} (
    operation_id,
    contract,
    status,
    status_text,
    headers_entries_json,
    body_present,
    body_base64,
    body_length,
    url,
    redirected,
    response_type,
    recorded_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

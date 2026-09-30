export const HTTP_BODYINIT_CONTRACT_ID = 'http_bodyinit_v1';
export const HTTP_BODY_WRITE_ACTION_TYPE = 'http_body_write_v1';

export class HttpBodyInitExecutionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'HttpBodyInitExecutionError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new HttpBodyInitExecutionError(
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

function requireExactKeys(value, expected, label) {
  if (!isPlainObject(value)) {
    fail('invalid_http_body_shape', `${label} must be a plain object.`);
  }

  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();

  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(
      'invalid_http_body_shape',
      `${label} must contain exactly: ${wanted.join(', ')}.`,
    );
  }
}

function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }

  return true;
}

function requireString(value, label, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') {
    fail('invalid_http_body_string', `${label} must be a string.`);
  }

  if (!allowEmpty && value.length === 0) {
    fail('invalid_http_body_string', `${label} must not be empty.`);
  }

  if (!isWellFormedUnicode(value)) {
    fail('invalid_http_body_string', `${label} must contain well-formed Unicode.`);
  }

  return value;
}

function decodeCanonicalBase64(value, label) {
  requireString(value, label);

  let binary;
  try {
    binary = atob(value);
  }
  catch (error) {
    fail('invalid_http_body_base64', `${label} must be valid base64.`, error);
  }

  if (btoa(binary) !== value) {
    fail('invalid_http_body_base64', `${label} must use canonical base64 encoding.`);
  }

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function requireByteLength(value, expectedLength, label) {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
    fail('invalid_http_body_length', `${label} must be a non-negative safe integer.`);
  }

  if (value.byteLength !== expectedLength) {
    fail('http_body_length_mismatch', `${label} does not match decoded body length.`);
  }
}

function canonicalHttpsUrl(value) {
  requireString(value, 'action.url', { allowEmpty: false });

  let parsed;
  try {
    parsed = new URL(value);
  }
  catch (error) {
    fail('invalid_http_body_target_url', 'action.url must be a valid HTTPS URL.', error);
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    fail(
      'invalid_http_body_target_url',
      'action.url must be HTTPS without credentials or a fragment.',
    );
  }

  parsed.searchParams.sort();
  const canonical = parsed.toString();

  if (canonical !== value) {
    fail(
      'noncanonical_http_body_target_url',
      'action.url must be the exact canonical HTTPS URL.',
    );
  }

  return canonical;
}

function exactMethod(value) {
  if (value === 'POST' || value === 'PUT' || value === 'PATCH' || value === 'DELETE') {
    return value;
  }

  fail(
    'invalid_http_body_method',
    'action.method must be exact POST, PUT, PATCH, or DELETE.',
  );
}

function canonicalContentType(value) {
  if (value === null) return null;

  const contentType = requireString(value, 'body_v1.content_type', { allowEmpty: false });

  if (contentType !== contentType.trim() || /[\r\n]/.test(contentType)) {
    fail(
      'invalid_http_body_content_type',
      'body_v1.content_type must be a single canonical header value.',
    );
  }

  try {
    const headers = new Headers({ 'content-type': contentType });
    if (headers.get('content-type') !== contentType) {
      fail(
        'invalid_http_body_content_type',
        'body_v1.content_type must survive Headers normalization unchanged.',
      );
    }
  }
  catch (error) {
    fail('invalid_http_body_content_type', 'body_v1.content_type is not a valid header value.', error);
  }

  return contentType;
}

function canonicalBlobMediaType(value) {
  const mediaType = requireString(value, 'form file media_type');

  let normalized;
  try {
    normalized = new Blob([], { type: mediaType }).type;
  }
  catch (error) {
    fail('invalid_http_body_media_type', 'form file media_type is invalid.', error);
  }

  if (normalized !== mediaType) {
    fail(
      'invalid_http_body_media_type',
      'form file media_type must already be in the platform canonical form.',
    );
  }

  return mediaType;
}

function materializeBytesBody(bodyV1) {
  requireExactKeys(
    bodyV1,
    ['contract', 'kind', 'bytes_base64', 'byte_length', 'content_type'],
    'bytes body_v1',
  );

  const bytes = decodeCanonicalBase64(bodyV1.bytes_base64, 'body_v1.bytes_base64');
  requireByteLength(bytes, bodyV1.byte_length, 'body_v1.byte_length');

  return {
    body: bytes,
    contentType: canonicalContentType(bodyV1.content_type),
  };
}

function materializeFormDataBody(bodyV1) {
  requireExactKeys(bodyV1, ['contract', 'kind', 'entries'], 'form_data body_v1');

  if (!Array.isArray(bodyV1.entries)) {
    fail('invalid_http_body_form_data', 'body_v1.entries must be an array.');
  }

  const form = new FormData();

  for (const entry of bodyV1.entries) {
    requireExactKeys(entry, ['name', 'value'], 'form_data entry');
    const name = requireString(entry.name, 'form_data entry name');
    const value = entry.value;

    if (!isPlainObject(value)) {
      fail('invalid_http_body_form_data', 'form_data entry value must be a plain object.');
    }

    if (value.kind === 'text') {
      requireExactKeys(value, ['kind', 'text'], 'form_data text value');
      form.append(name, requireString(value.text, 'form_data text value'));
      continue;
    }

    if (value.kind === 'file') {
      requireExactKeys(
        value,
        ['kind', 'filename', 'media_type', 'bytes_base64', 'byte_length'],
        'form_data file value',
      );

      const filename = requireString(value.filename, 'form_data file filename');
      const mediaType = canonicalBlobMediaType(value.media_type);
      const bytes = decodeCanonicalBase64(
        value.bytes_base64,
        'form_data file bytes_base64',
      );
      requireByteLength(bytes, value.byte_length, 'form_data file byte_length');

      form.append(
        name,
        new Blob([bytes], { type: mediaType }),
        filename,
      );
      continue;
    }

    fail(
      'invalid_http_body_form_data',
      'form_data entry kind must be exact text or file.',
    );
  }

  return {
    body: form,
    contentType: null,
  };
}

export function materializeHttpBodyInitV1(bodyV1) {
  if (!isPlainObject(bodyV1)) {
    fail('invalid_http_body_shape', 'body_v1 must be a plain object.');
  }

  if (bodyV1.contract !== HTTP_BODYINIT_CONTRACT_ID) {
    fail(
      'unsupported_http_body_contract',
      `body_v1.contract must be exact ${HTTP_BODYINIT_CONTRACT_ID}.`,
    );
  }

  if (bodyV1.kind === 'none') {
    requireExactKeys(bodyV1, ['contract', 'kind'], 'none body_v1');
    return { body: undefined, contentType: null };
  }

  if (bodyV1.kind === 'bytes') {
    return materializeBytesBody(bodyV1);
  }

  if (bodyV1.kind === 'form_data') {
    return materializeFormDataBody(bodyV1);
  }

  fail(
    'unsupported_http_body_kind',
    'body_v1.kind must be exact none, bytes, or form_data.',
  );
}

/**
 * Materialize the future `http_body_write_v1` action as a native Request
 * without dispatching it. This is a server/provider execution contract only;
 * it intentionally does not alter the current runtime router or provider path.
 */
export function materializeHttpBodyWriteRequestV1(action) {
  requireExactKeys(action, ['type', 'method', 'url', 'body_v1'], 'http body action');

  if (action.type !== HTTP_BODY_WRITE_ACTION_TYPE) {
    fail(
      'unsupported_http_body_action',
      `action.type must be exact ${HTTP_BODY_WRITE_ACTION_TYPE}.`,
    );
  }

  const method = exactMethod(action.method);
  const url = canonicalHttpsUrl(action.url);
  const materialized = materializeHttpBodyInitV1(action.body_v1);
  const headers = new Headers();

  if (materialized.contentType !== null) {
    headers.set('content-type', materialized.contentType);
  }

  const init = {
    method,
    ...(headers.size > 0 ? { headers } : {}),
    ...(materialized.body === undefined ? {} : { body: materialized.body }),
  };

  try {
    return new Request(url, init);
  }
  catch (error) {
    fail(
      'http_body_request_materialization_failed',
      'The validated BodyInit action could not be materialized as a native Request.',
      error,
    );
  }
}

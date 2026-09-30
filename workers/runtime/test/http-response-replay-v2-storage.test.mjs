import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HTTP_RESPONSE_REPLAY_V2_CONTRACT,
  HTTP_RESPONSE_REPLAY_V2_CREATE_SQL,
  HTTP_RESPONSE_REPLAY_V2_TABLE,
  HttpResponseReplayV2StorageError,
  assertHttpResponseReplayV2Idempotent,
  decodeHttpResponseReplayV2Row,
  encodeHttpResponseReplayV2Row,
  httpResponseReplayV2InsertSql,
} from '../src/http-response-replay-v2-storage.mjs';

function baseReceipt(overrides = {}) {
  const body = Buffer.from([0, 255, 1, 2, 3]);
  return {
    contract: HTTP_RESPONSE_REPLAY_V2_CONTRACT,
    status: 201,
    status_text: 'Created',
    headers_entries: [
      ['content-type', 'application/octet-stream'],
      ['x-once-test', 'v2'],
    ],
    body_present: true,
    body_base64: body.toString('base64'),
    body_length: body.byteLength,
    url: 'https://api.example.invalid/final',
    redirected: true,
    type: 'basic',
    ...overrides,
  };
}

function row(overrides = {}, recordedAt = '2026-09-30T17:45:00.000Z') {
  return encodeHttpResponseReplayV2Row('op_response_v2', baseReceipt(overrides), recordedAt);
}

test('v2 storage uses a separate table and fixed insert surface', () => {
  assert.equal(HTTP_RESPONSE_REPLAY_V2_TABLE, 'http_response_replays_v2');
  assert.match(HTTP_RESPONSE_REPLAY_V2_CREATE_SQL, /CREATE TABLE IF NOT EXISTS http_response_replays_v2/);
  assert.doesNotMatch(HTTP_RESPONSE_REPLAY_V2_CREATE_SQL, /CREATE TABLE IF NOT EXISTS http_response_replays\s*\(/);

  const insert = httpResponseReplayV2InsertSql();
  assert.match(insert, /^INSERT INTO http_response_replays_v2/);
  assert.equal((insert.match(/\?/g) ?? []).length, 12);
});

test('v2 storage round-trips exact receipt fields without text coercion', () => {
  const stored = row();
  const decoded = decodeHttpResponseReplayV2Row(stored);

  assert.equal(decoded.operation_id, 'op_response_v2');
  assert.equal(decoded.contract, HTTP_RESPONSE_REPLAY_V2_CONTRACT);
  assert.equal(decoded.status, 201);
  assert.equal(decoded.status_text, 'Created');
  assert.deepEqual(decoded.headers_entries, baseReceipt().headers_entries);
  assert.equal(decoded.body_present, true);
  assert.equal(decoded.body_base64, baseReceipt().body_base64);
  assert.equal(decoded.body_length, 5);
  assert.equal(decoded.url, 'https://api.example.invalid/final');
  assert.equal(decoded.redirected, true);
  assert.equal(decoded.type, 'basic');
  assert.equal(decoded.recorded_at, '2026-09-30T17:45:00.000Z');

  assert.equal(Object.hasOwn(stored, 'body_text'), false);
  assert.equal(Object.hasOwn(stored, 'headers_json'), false);
});

test('same operation and identical replay is idempotent even with a later recorded_at', () => {
  const first = row({}, '2026-09-30T17:45:00.000Z');
  const later = row({}, '2026-09-30T17:46:00.000Z');

  const existing = assertHttpResponseReplayV2Idempotent(first, later);
  assert.equal(existing.recorded_at, '2026-09-30T17:45:00.000Z');
});

test('any response-semantic or byte change conflicts', () => {
  const first = row();
  const changes = [
    { status: 202, status_text: 'Accepted' },
    { status_text: 'Created Differently' },
    { headers_entries: [['content-type', 'application/octet-stream'], ['x-once-test', 'changed']] },
    { body_base64: Buffer.from([0, 255, 1, 2, 4]).toString('base64') },
    { body_length: 4, body_base64: Buffer.from([0, 255, 1, 2]).toString('base64') },
    { url: 'https://api.example.invalid/other' },
    { redirected: false },
    { type: 'cors' },
  ];

  for (const change of changes) {
    const candidate = row(change);
    assert.throws(
      () => assertHttpResponseReplayV2Idempotent(first, candidate),
      error => error instanceof HttpResponseReplayV2StorageError &&
        error.code === 'http_response_replay_v2_storage_conflict',
      JSON.stringify(change),
    );
  }
});

test('null-body receipts remain explicit and round-trip as zero bytes', () => {
  const stored = row({
    status: 204,
    status_text: 'No Content',
    body_present: false,
    body_base64: '',
    body_length: 0,
    redirected: false,
  });
  const decoded = decodeHttpResponseReplayV2Row(stored);
  assert.equal(decoded.body_present, false);
  assert.equal(decoded.body_length, 0);
  assert.equal(decoded.body_base64, '');
});

test('legacy v1 replay rows cannot be decoded or promoted as v2', () => {
  const legacy = {
    operation_id: 'op_response_v2',
    status: 200,
    body_text: '{"ok":true}',
    headers_json: '{"content-type":"application/json"}',
    recorded_at: '2026-09-30T17:45:00.000Z',
  };

  assert.throws(
    () => decodeHttpResponseReplayV2Row(legacy),
    error => error instanceof HttpResponseReplayV2StorageError &&
      error.code === 'invalid_http_response_replay_v2_storage_shape',
  );
});

test('malformed storage inputs fail closed before a row can be produced', () => {
  const invalidReceipts = [
    { ...baseReceipt(), hidden: true },
    { ...baseReceipt(), body_base64: '***' },
    { ...baseReceipt(), body_length: 99 },
    { ...baseReceipt(), headers_entries: [['X-Test', '1']] },
    { ...baseReceipt(), url: 'https://user:pass@example.invalid/final' },
    { ...baseReceipt(), type: 'opaque' },
    {
      ...baseReceipt(),
      status: 204,
      status_text: 'No Content',
      body_present: true,
    },
  ];

  for (const receipt of invalidReceipts) {
    assert.throws(
      () => encodeHttpResponseReplayV2Row(
        'op_response_v2',
        receipt,
        '2026-09-30T17:45:00.000Z',
      ),
      HttpResponseReplayV2StorageError,
    );
  }
});

test('body and header limits are enforced before durable persistence', () => {
  const tooLargeBody = Buffer.alloc(1048577, 1);
  assert.throws(
    () => encodeHttpResponseReplayV2Row(
      'op_response_v2',
      baseReceipt({
        body_base64: tooLargeBody.toString('base64'),
        body_length: tooLargeBody.byteLength,
      }),
      '2026-09-30T17:45:00.000Z',
    ),
    error => error instanceof HttpResponseReplayV2StorageError &&
      error.code === 'http_response_replay_v2_storage_body_too_large',
  );

  const hugeHeader = 'x'.repeat(17000);
  assert.throws(
    () => encodeHttpResponseReplayV2Row(
      'op_response_v2',
      baseReceipt({
        headers_entries: [['x-large', hugeHeader]],
      }),
      '2026-09-30T17:45:00.000Z',
    ),
    error => error instanceof HttpResponseReplayV2StorageError &&
      error.code === 'http_response_replay_v2_storage_headers_too_large',
  );
});

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  HTTP_RESPONSE_REPLAY_V2_CONTRACT,
  HttpResponseReplayV2PersistenceError,
  HttpResponseReplayV2Store,
  captureHttpResponseReplayV2ForProvider,
  validateHttpResponseReplayV2ForPersistence,
} from '../src/http-response-replay-v2-persistence.mjs';

class MemorySql {
  constructor() {
    this.rows = new Map();
  }

  exec(statement, ...args) {
    const sql = String(statement).replace(/\s+/g, ' ').trim();

    if (sql.startsWith('CREATE TABLE IF NOT EXISTS http_response_replays_v2')) {
      return [];
    }

    if (
      sql.startsWith('SELECT receipt_json, recorded_at') &&
      sql.includes('FROM http_response_replays_v2')
    ) {
      const row = this.rows.get(String(args[0]));
      return row ? [row] : [];
    }

    if (sql.startsWith('INSERT INTO http_response_replays_v2')) {
      const [operationId, receiptJson, recordedAt] = args.map(String);
      if (this.rows.has(operationId)) throw new Error('UNIQUE constraint failed');
      this.rows.set(operationId, {
        receipt_json: receiptJson,
        recorded_at: recordedAt,
      });
      return [];
    }

    throw new Error(`unexpected SQL in test: ${sql}`);
  }
}

function expectContractError(fn, code) {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error instanceof HttpResponseReplayV2PersistenceError, true);
      assert.equal(error.code, code);
      return true;
    },
  );
}

function fixture(overrides = {}) {
  const body = Buffer.from([0, 1, 2, 127, 128, 255]);
  return {
    contract: HTTP_RESPONSE_REPLAY_V2_CONTRACT,
    status: 201,
    status_text: 'Created For Once',
    headers_entries: [
      ['content-type', 'application/octet-stream'],
      ['x-once-test', 'v2'],
    ],
    body_present: true,
    body_base64: body.toString('base64'),
    body_length: body.byteLength,
    url: 'https://api.example.invalid/orders/1',
    redirected: false,
    type: 'default',
    ...overrides,
  };
}

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  }
  finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
}

test('provider capture clones the native response and preserves exact observable metadata', async () => {
  await withServer(
    (request, response) => {
      if (request.url === '/start') {
        response.statusCode = 302;
        response.setHeader('location', '/final');
        response.end();
        return;
      }

      response.statusCode = 201;
      response.statusMessage = 'Created For Once';
      response.setHeader('content-type', 'application/octet-stream');
      response.setHeader('x-once-test', 'v2');
      response.end(Buffer.from([0, 1, 2, 127, 128, 255]));
    },
    async (origin) => {
      const response = await fetch(`${origin}/start`);
      const receipt = await captureHttpResponseReplayV2ForProvider(response);

      assert.equal(response.bodyUsed, false);
      assert.equal(receipt.contract, HTTP_RESPONSE_REPLAY_V2_CONTRACT);
      assert.equal(receipt.status, 201);
      assert.equal(receipt.status_text, 'Created For Once');
      assert.equal(receipt.url, `${origin}/final`);
      assert.equal(receipt.redirected, true);
      assert.deepEqual(
        [...Buffer.from(receipt.body_base64, 'base64')],
        [0, 1, 2, 127, 128, 255],
      );

      assert.deepEqual(
        [...new Uint8Array(await response.arrayBuffer())],
        [0, 1, 2, 127, 128, 255],
      );
    },
  );
});

test('strict v2 validation rejects legacy text receipts and hidden extra fields', () => {
  expectContractError(
    () => validateHttpResponseReplayV2ForPersistence({
      status: 200,
      body_text: '{"ok":true}',
      headers: { 'content-type': 'application/json' },
    }),
    'invalid_http_response_replay_v2_shape',
  );

  expectContractError(
    () => validateHttpResponseReplayV2ForPersistence({
      ...fixture(),
      body_text: 'must not be accepted as parallel truth',
    }),
    'invalid_http_response_replay_v2_shape',
  );
});

test('noncanonical bytes, headers, URLs, and unsupported response types fail closed', () => {
  expectContractError(
    () => validateHttpResponseReplayV2ForPersistence({
      ...fixture(),
      body_base64: 'AB==',
      body_length: 1,
    }),
    'invalid_http_response_replay_v2_base64',
  );

  expectContractError(
    () => validateHttpResponseReplayV2ForPersistence({
      ...fixture(),
      headers_entries: [['X-Test', '1']],
    }),
    'noncanonical_http_response_replay_v2_headers',
  );

  expectContractError(
    () => validateHttpResponseReplayV2ForPersistence({
      ...fixture(),
      url: 'https://api.example.invalid/orders?z=2&a=1',
    }),
    'invalid_http_response_replay_v2_url',
  );

  expectContractError(
    () => validateHttpResponseReplayV2ForPersistence({
      ...fixture(),
      type: 'opaque',
    }),
    'unsupported_http_response_replay_v2_type',
  );
});

test('null-body status cannot claim a replay body', () => {
  expectContractError(
    () => validateHttpResponseReplayV2ForPersistence({
      ...fixture(),
      status: 204,
      status_text: 'No Content',
    }),
    'invalid_http_response_replay_v2_body_presence',
  );

  const valid = validateHttpResponseReplayV2ForPersistence({
    ...fixture(),
    status: 204,
    status_text: 'No Content',
    body_present: false,
    body_base64: '',
    body_length: 0,
  });
  assert.equal(valid.body_present, false);
});

test('durable v2 store is idempotent for identical evidence and conflicts on changed evidence', () => {
  const sql = new MemorySql();
  const store = new HttpResponseReplayV2Store(sql);
  const recordedAt = '2026-09-30T18:00:00.000Z';

  const first = store.record('op-1', fixture(), { recordedAt });
  const replay = store.record('op-1', fixture(), { recordedAt: 'later-is-not-authoritative' });

  assert.deepEqual(replay, first);
  assert.equal(first.operation_id, 'op-1');
  assert.equal(first.recorded_at, recordedAt);
  assert.deepEqual(first.receipt, fixture());

  expectContractError(
    () => store.record('op-1', fixture({ status: 202, status_text: 'Accepted' })),
    'http_response_replay_v2_conflict',
  );
});

test('corrupt durable JSON never degrades into guessed replay evidence', () => {
  const sql = new MemorySql();
  const store = new HttpResponseReplayV2Store(sql);
  sql.rows.set('op-corrupt', {
    receipt_json: '{not-json',
    recorded_at: '2026-09-30T18:00:00.000Z',
  });

  expectContractError(
    () => store.get('op-corrupt'),
    'http_response_replay_v2_corrupt_json',
  );
});

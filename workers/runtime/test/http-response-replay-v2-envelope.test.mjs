import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachHttpResponseReplayV2,
} from '../src/http-response-replay-v2-envelope.mjs';

function replayV1(overrides = {}) {
  return {
    status: 201,
    body_text: '{"created":true}',
    headers: {
      'content-type': 'application/json',
    },
    recorded_at: '2026-09-30T18:30:00.000Z',
    ...overrides,
  };
}

function replayV2(overrides = {}) {
  const body = Buffer.from('{"created":true}', 'utf8');
  return {
    operation_id: 'op-1',
    recorded_at: '2026-09-30T18:30:00.000Z',
    receipt: {
      contract: 'http_response_replay_v2',
      status: 201,
      status_text: 'Created',
      headers_entries: [
        ['content-type', 'application/json'],
      ],
      body_present: true,
      body_base64: body.toString('base64'),
      body_length: body.byteLength,
      url: 'https://api.example.invalid/orders/1',
      redirected: false,
      type: 'default',
      ...overrides,
    },
  };
}

test('compatible durable v2 is exposed additively beside unchanged v1 fields', () => {
  const v1 = replayV1();
  const result = attachHttpResponseReplayV2(v1, replayV2());

  assert.equal(result.status, v1.status);
  assert.equal(result.body_text, v1.body_text);
  assert.deepEqual(result.headers, v1.headers);
  assert.equal(result.recorded_at, v1.recorded_at);
  assert.equal(result.replay_v2.contract, 'http_response_replay_v2');
  assert.equal(result.replay_v2.url, 'https://api.example.invalid/orders/1');
});

test('missing v2 leaves legacy v1 replay unchanged', () => {
  const v1 = replayV1();
  assert.deepEqual(
    attachHttpResponseReplayV2(v1, undefined),
    v1,
  );
});

test('status contradiction suppresses v2 exposure without changing v1', () => {
  const v1 = replayV1();
  const result = attachHttpResponseReplayV2(
    v1,
    replayV2({ status: 202, status_text: 'Accepted' }),
  );

  assert.deepEqual(result, v1);
  assert.equal('replay_v2' in result, false);
});

test('text-view contradiction suppresses v2 exposure without changing v1', () => {
  const v1 = replayV1({ body_text: '{"created":false}' });
  const result = attachHttpResponseReplayV2(v1, replayV2());

  assert.deepEqual(result, v1);
  assert.equal('replay_v2' in result, false);
});

test('corrupt v2 bytes fail closed to v1', () => {
  const v1 = replayV1();
  const result = attachHttpResponseReplayV2(
    v1,
    replayV2({ body_base64: '***not-base64***' }),
  );

  assert.deepEqual(result, v1);
  assert.equal('replay_v2' in result, false);
});

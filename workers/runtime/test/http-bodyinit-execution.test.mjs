import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HTTP_BODYINIT_CONTRACT_ID,
  HTTP_BODY_WRITE_ACTION_TYPE,
  HttpBodyInitExecutionError,
  materializeHttpBodyInitV1,
  materializeHttpBodyWriteRequestV1,
} from '../src/http-bodyinit-execution.mjs';

function bytesBody(bytes, contentType = null) {
  const buffer = Buffer.from(bytes);
  return {
    contract: HTTP_BODYINIT_CONTRACT_ID,
    kind: 'bytes',
    bytes_base64: buffer.toString('base64'),
    byte_length: buffer.byteLength,
    content_type: contentType,
  };
}

function action(bodyV1, overrides = {}) {
  return {
    type: HTTP_BODY_WRITE_ACTION_TYPE,
    method: 'POST',
    url: 'https://api.example.invalid/orders',
    body_v1: bodyV1,
    ...overrides,
  };
}

function expectContractError(fn, code) {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error instanceof HttpBodyInitExecutionError, true);
      assert.equal(error.code, code);
      return true;
    },
  );
}

test('bytes body reconstructs exact native request bytes and content type', async () => {
  const request = materializeHttpBodyWriteRequestV1(
    action(bytesBody(Buffer.from('hello'), 'text/plain;charset=UTF-8')),
  );

  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://api.example.invalid/orders');
  assert.equal(request.headers.get('content-type'), 'text/plain;charset=UTF-8');
  assert.equal(request.headers.get('authorization'), null);
  assert.equal(await request.text(), 'hello');
});

test('binary bytes reconstruct exactly without inventing content type', async () => {
  const original = new Uint8Array([0, 1, 2, 127, 128, 255]);
  const request = materializeHttpBodyWriteRequestV1(action(bytesBody(original)));

  assert.equal(request.headers.get('content-type'), null);
  assert.deepEqual(
    [...new Uint8Array(await request.arrayBuffer())],
    [...original],
  );
});

test('none body reconstructs without a body or content type', async () => {
  const request = materializeHttpBodyWriteRequestV1(
    action({ contract: HTTP_BODYINIT_CONTRACT_ID, kind: 'none' }, { method: 'DELETE' }),
  );

  assert.equal(request.method, 'DELETE');
  assert.equal(request.headers.get('content-type'), null);
  assert.equal(await request.text(), '');
});

test('semantic FormData reconstructs ordered duplicates and exact file bytes', async () => {
  const normalized = {
    contract: HTTP_BODYINIT_CONTRACT_ID,
    kind: 'form_data',
    entries: [
      {
        name: 'tag',
        value: { kind: 'text', text: 'first' },
      },
      {
        name: 'tag',
        value: { kind: 'text', text: 'second' },
      },
      {
        name: 'asset',
        value: {
          kind: 'file',
          filename: 'payload.bin',
          media_type: 'application/octet-stream',
          bytes_base64: Buffer.from([3, 1, 4, 1, 5]).toString('base64'),
          byte_length: 5,
        },
      },
    ],
  };

  const first = materializeHttpBodyWriteRequestV1(action(normalized));
  const second = materializeHttpBodyWriteRequestV1(action(normalized));

  for (const request of [first, second]) {
    assert.match(request.headers.get('content-type') ?? '', /^multipart\/form-data;\s*boundary=/i);
    assert.equal(request.headers.get('authorization'), null);

    const form = await request.formData();
    assert.deepEqual(form.getAll('tag'), ['first', 'second']);

    const file = form.get('asset');
    assert.ok(file instanceof Blob);
    assert.equal(file.name, 'payload.bin');
    assert.equal(file.type, 'application/octet-stream');
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [3, 1, 4, 1, 5]);
  }

  assert.equal(/boundary/i.test(JSON.stringify(normalized)), false);
});

test('standalone BodyInit materializer returns semantic FormData rather than boundary bytes', () => {
  const normalized = {
    contract: HTTP_BODYINIT_CONTRACT_ID,
    kind: 'form_data',
    entries: [
      { name: 'a', value: { kind: 'text', text: '1' } },
      { name: 'a', value: { kind: 'text', text: '2' } },
    ],
  };

  const result = materializeHttpBodyInitV1(normalized);
  assert.ok(result.body instanceof FormData);
  assert.equal(result.contentType, null);
  assert.deepEqual(result.body.getAll('a'), ['1', '2']);
});

test('action and body objects reject hidden extra fields', () => {
  expectContractError(
    () => materializeHttpBodyWriteRequestV1({
      ...action(bytesBody(Buffer.from('x'))),
      headers: { authorization: 'Bearer should-never-be-accepted' },
    }),
    'invalid_http_body_shape',
  );

  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action({ ...bytesBody(Buffer.from('x')), ignored: true }),
    ),
    'invalid_http_body_shape',
  );
});

test('noncanonical base64 and mismatched byte lengths fail closed', () => {
  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action({
        contract: HTTP_BODYINIT_CONTRACT_ID,
        kind: 'bytes',
        bytes_base64: 'AB==',
        byte_length: 1,
        content_type: null,
      }),
    ),
    'invalid_http_body_base64',
  );

  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action({
        ...bytesBody(Buffer.from('x')),
        byte_length: 2,
      }),
    ),
    'http_body_length_mismatch',
  );
});

test('content type must be an exact safe header value', () => {
  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action(bytesBody(Buffer.from('x'), ' text/plain')),
    ),
    'invalid_http_body_content_type',
  );

  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action(bytesBody(Buffer.from('x'), 'text/plain\r\nx-evil: 1')),
    ),
    'invalid_http_body_content_type',
  );
});

test('FormData strings and media types must already be canonical', () => {
  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action({
        contract: HTTP_BODYINIT_CONTRACT_ID,
        kind: 'form_data',
        entries: [
          {
            name: '\ud800',
            value: { kind: 'text', text: 'x' },
          },
        ],
      }),
    ),
    'invalid_http_body_string',
  );

  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action({
        contract: HTTP_BODYINIT_CONTRACT_ID,
        kind: 'form_data',
        entries: [
          {
            name: 'asset',
            value: {
              kind: 'file',
              filename: 'asset.bin',
              media_type: 'APPLICATION/OCTET-STREAM',
              bytes_base64: Buffer.from([1]).toString('base64'),
              byte_length: 1,
            },
          },
        ],
      }),
    ),
    'invalid_http_body_media_type',
  );
});

test('method, action type, and target URL remain exact and fail closed', () => {
  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action(bytesBody(Buffer.from('x')), { method: 'post' }),
    ),
    'invalid_http_body_method',
  );

  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action(bytesBody(Buffer.from('x')), { type: 'http_write_v1' }),
    ),
    'unsupported_http_body_action',
  );

  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action(bytesBody(Buffer.from('x')), {
        url: 'https://api.example.invalid/orders?z=2&a=1',
      }),
    ),
    'noncanonical_http_body_target_url',
  );

  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action(bytesBody(Buffer.from('x')), {
        url: 'https://user:pass@api.example.invalid/orders',
      }),
    ),
    'invalid_http_body_target_url',
  );
});

test('unknown contract and body kinds remain unsupported', () => {
  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action({ contract: 'http_bodyinit_v2', kind: 'none' }),
    ),
    'unsupported_http_body_contract',
  );

  expectContractError(
    () => materializeHttpBodyWriteRequestV1(
      action({ contract: HTTP_BODYINIT_CONTRACT_ID, kind: 'stream' }),
    ),
    'unsupported_http_body_kind',
  );
});

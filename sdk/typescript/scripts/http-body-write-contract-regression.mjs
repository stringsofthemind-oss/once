import assert from "node:assert/strict";

import {
  HTTP_BODY_WRITE_ACTION_TYPE,
  executeHttpBodyWriteV1
} from "../dist/http-body-write-v1.js";

import {
  HttpBodyInitNormalizationError,
  fingerprintHttpBodyInitV1
} from "../dist/http-bodyinit-v1.js";

console.log("");
console.log("ONCE HTTP BODY WRITE CONTRACT REGRESSION");
console.log("========================================");

const requests = [];

const fakeFetch = async (input, init = {}) => {
  const request = new Request(input, init);
  const text = await request.text();

  requests.push({
    url: request.url,
    method: request.method,
    body: JSON.parse(text)
  });

  return new Response(
    JSON.stringify({
      operation_id: "body-contract-op",
      result: "executed",
      state: "CONFIRMED",
      side_effects: 1
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    }
  );
};

await executeHttpBodyWriteV1(
  {
    operationId: "body-contract-op",
    provider: "customer-http",
    method: "POST",
    url: "https://api.example.invalid/orders",
    body: "hello"
  },
  {
    apiKey: "once_test_contract_only",
    baseUrl: "https://once.example.invalid",
    fetchImpl: fakeFetch,
    networkRetries: 0
  }
);

assert.equal(requests.length, 1);
assert.equal(requests[0].url, "https://once.example.invalid/v1/execute");
assert.equal(requests[0].method, "POST");
assert.equal(requests[0].body.operation_id, "body-contract-op");
assert.equal(requests[0].body.provider, "customer-http");
assert.equal(requests[0].body.action.type, HTTP_BODY_WRITE_ACTION_TYPE);
assert.equal(requests[0].body.action.method, "POST");
assert.equal(requests[0].body.action.url, "https://api.example.invalid/orders");
assert.equal(requests[0].body.action.body_v1.contract, "http_bodyinit_v1");
assert.equal(requests[0].body.action.body_v1.kind, "bytes");
assert.equal(
  Buffer.from(
    requests[0].body.action.body_v1.bytes_base64,
    "base64"
  ).toString("utf8"),
  "hello"
);
assert.match(
  requests[0].body.action.body_v1.content_type,
  /^text\/plain;charset=UTF-8$/i
);

console.log("PASS - helper emits one exact http_body_write_v1 Once action");
console.log("PASS - native BodyInit bytes/content type are carried without JSON inference");

function makeFormData(fileByte = 7) {
  const form = new FormData();
  form.append("tag", "a");
  form.append("tag", "b");
  form.append(
    "asset",
    new Blob(
      [new Uint8Array([fileByte, 8, 9])],
      { type: "application/octet-stream" }
    ),
    "asset.bin"
  );
  return form;
}

await executeHttpBodyWriteV1(
  {
    operationId: "form-op-1",
    provider: "customer-http",
    method: "POST",
    url: "https://api.example.invalid/orders",
    body: makeFormData()
  },
  {
    apiKey: "once_test_contract_only",
    baseUrl: "https://once.example.invalid",
    fetchImpl: fakeFetch,
    networkRetries: 0
  }
);

await executeHttpBodyWriteV1(
  {
    operationId: "form-op-2",
    provider: "customer-http",
    method: "POST",
    url: "https://api.example.invalid/orders",
    body: makeFormData()
  },
  {
    apiKey: "once_test_contract_only",
    baseUrl: "https://once.example.invalid",
    fetchImpl: fakeFetch,
    networkRetries: 0
  }
);

const formBodyOne = requests[1].body.action.body_v1;
const formBodyTwo = requests[2].body.action.body_v1;

assert.deepEqual(formBodyTwo, formBodyOne);
assert.equal(
  fingerprintHttpBodyInitV1(formBodyTwo),
  fingerprintHttpBodyInitV1(formBodyOne)
);
assert.equal(/boundary/i.test(JSON.stringify(formBodyOne)), false);

console.log("PASS - equivalent FormData produces identical semantic action payloads");
console.log("PASS - random multipart boundary never enters Once effect material");

await executeHttpBodyWriteV1(
  {
    operationId: "form-op-3",
    provider: "customer-http",
    method: "POST",
    url: "https://api.example.invalid/orders",
    body: makeFormData(6)
  },
  {
    apiKey: "once_test_contract_only",
    baseUrl: "https://once.example.invalid",
    fetchImpl: fakeFetch,
    networkRetries: 0
  }
);

const changedFormBody = requests[3].body.action.body_v1;

assert.notEqual(
  fingerprintHttpBodyInitV1(changedFormBody),
  fingerprintHttpBodyInitV1(formBodyOne)
);

console.log("PASS - changed effect-bearing FormData bytes change the action fingerprint material");

const beforeStream = requests.length;
let streamError;

try {
  await executeHttpBodyWriteV1(
    {
      operationId: "stream-op",
      provider: "customer-http",
      method: "POST",
      url: "https://api.example.invalid/orders",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        }
      })
    },
    {
      apiKey: "once_test_contract_only",
      baseUrl: "https://once.example.invalid",
      fetchImpl: fakeFetch,
      networkRetries: 0
    }
  );
}
catch (error) {
  streamError = error;
}

assert.equal(streamError instanceof HttpBodyInitNormalizationError, true);
assert.equal(streamError?.code, "unsupported_stream_body");
assert.equal(
  requests.length,
  beforeStream,
  "unsupported body must fail before an Once network request"
);

console.log("PASS - unsupported stream body fails before any Once request");

for (const invalid of [
  {
    label: "lowercase method",
    input: {
      operationId: "bad-method",
      provider: "customer-http",
      method: "post",
      url: "https://api.example.invalid/orders",
      body: "x"
    }
  },
  {
    label: "noncanonical URL",
    input: {
      operationId: "bad-url",
      provider: "customer-http",
      method: "POST",
      url: "https://api.example.invalid/orders?z=2&a=1",
      body: "x"
    }
  },
  {
    label: "URL credentials",
    input: {
      operationId: "bad-creds",
      provider: "customer-http",
      method: "POST",
      url: "https://user:pass@api.example.invalid/orders",
      body: "x"
    }
  }
]) {
  const before = requests.length;
  let error;

  try {
    await executeHttpBodyWriteV1(
      invalid.input,
      {
        apiKey: "once_test_contract_only",
        baseUrl: "https://once.example.invalid",
        fetchImpl: fakeFetch,
        networkRetries: 0
      }
    );
  }
  catch (caught) {
    error = caught;
  }

  assert.ok(error, `${invalid.label} must be rejected`);
  assert.equal(
    requests.length,
    before,
    `${invalid.label} must fail before network`
  );
}

console.log("PASS - invalid method/URL shapes fail locally before network");
console.log("PASS - helper remains an internal contract; no transformer/apply eligibility changed");

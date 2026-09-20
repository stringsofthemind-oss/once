import assert from "node:assert/strict";

import {
  createOnceRuntimeFetch,
  OnceRuntimeBlockedError,
  OnceRuntimeHttpShapeError
} from "../dist/index.js";


const cloudCalls = [];
const nativeReads = [];
const directWrites = [];

const replay = {
  status: 201,
  body_text: JSON.stringify({
    order_id: "ord_runtime_001",
    accepted: true
  }),
  headers: {
    "content-type":
      "application/json; charset=utf-8",
    "x-request-id":
      "req_runtime_001"
  },
  recorded_at:
    "2026-09-19T21:00:00.000Z"
};


const nativeFetch =
  async (input, init) => {

    const request =
      new Request(input, init);

    const url =
      new URL(request.url);

    if (
      url.origin ===
        "https://once-runtime.test" &&
      url.pathname ===
        "/v1/execute"
    ) {
      const body =
        JSON.parse(
          await request.text()
        );

      cloudCalls.push(body);

      return new Response(
        JSON.stringify({
          operation_id:
            body.operation_id,
          result:
            cloudCalls.length === 1
              ? "executed"
              : "already_executed",
          state:
            "CONFIRMED",
          attempts:
            cloudCalls.length,
          side_effects:
            1,
          http_response:
            replay
        }),
        {
          status: 200,
          headers: {
            "content-type":
              "application/json"
          }
        }
      );
    }

    if (request.method === "GET") {
      nativeReads.push(
        request.url
      );

      return new Response(
        "native-read",
        {
          status: 200
        }
      );
    }

    directWrites.push(
      request.url
    );

    throw new Error(
      "Protected target write reached native fetch."
    );
  };


const runtime =
  createOnceRuntimeFetch({
    apiKey:
      "once_test_key",

    baseUrl:
      "https://once-runtime.test",

    provider:
      "orders",

    networkRetries:
      0,

    fetchImpl:
      nativeFetch
  });


const target =
  "https://api.allowed.test/v1/orders";

const init = {
  method: "POST",

  headers: {
    "content-type":
      "application/json",

    "idempotency-key":
      "order-request-001"
  },

  body:
    JSON.stringify({
      amount: 4200,
      currency: "GBP"
    })
};


const first =
  await runtime(
    target,
    init
  );

assert.equal(
  first.status,
  201
);

assert.equal(
  first.headers.get(
    "x-request-id"
  ),
  "req_runtime_001"
);

assert.deepEqual(
  await first.json(),
  {
    order_id:
      "ord_runtime_001",
    accepted:
      true
  }
);


const retry =
  await runtime(
    target,
    init
  );

assert.equal(
  retry.status,
  201
);

assert.equal(
  await retry.text(),
  replay.body_text
);

assert.equal(
  cloudCalls.length,
  2
);

assert.equal(
  directWrites.length,
  0
);

assert.equal(
  cloudCalls[0].operation_id,
  cloudCalls[1].operation_id
);

assert.match(
  cloudCalls[0].operation_id,
  /^http:[a-f0-9]{32}$/
);

assert.equal(
  cloudCalls[0].provider,
  "orders"
);

assert.deepEqual(
  cloudCalls[0].action,
  {
    type:
      "http_write_v1",

    method:
      "POST",

    url:
      target,

    body_json:
      init.body
  }
);


const read =
  await runtime(
    "https://api.allowed.test/v1/orders/1",
    {
      method:
        "GET"
    }
  );

assert.equal(
  await read.text(),
  "native-read"
);

assert.equal(
  nativeReads.length,
  1
);


await assert.rejects(
  () =>
    runtime(
      target,
      {
        method:
          "PUT",

        headers: {
          "content-type":
            "application/json",
          "idempotency-key":
            "put-001"
        },

        body:
          '{"amount":1}'
      }
    ),

  error => {
    assert.ok(
      error instanceof
        OnceRuntimeHttpShapeError
    );

    return true;
  }
);


await assert.rejects(
  () =>
    runtime(
      target,
      {
        method:
          "POST",

        headers: {
          "content-type":
            "application/json",
          "idempotency-key":
            "auth-001",
          "authorization":
            "Bearer target-secret"
        },

        body:
          '{"amount":1}'
      }
    ),

  error => {
    assert.ok(
      error instanceof
        OnceRuntimeHttpShapeError
    );

    assert.match(
      error.message,
      /authorization/i
    );

    return true;
  }
);


await assert.rejects(
  () =>
    runtime(
      target,
      {
        method:
          "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body:
          '{"amount":1}'
      }
    ),

  error => {
    assert.ok(
      error instanceof
        OnceRuntimeBlockedError
    );

    assert.equal(
      error.code,
      "IDENTITY_REQUIRED"
    );

    return true;
  }
);


assert.equal(
  cloudCalls.length,
  2
);

assert.equal(
  directWrites.length,
  0
);


console.log(
  JSON.stringify({
    proof:
      "runtime_cloud_replay_v0_1",

    stable_operation_id:
      cloudCalls[0].operation_id,

    cloud_execute_calls:
      cloudCalls.length,

    direct_target_writes:
      directWrites.length,

    native_reads:
      nativeReads.length,

    replay_status:
      retry.status,

    unsupported_put:
      "blocked",

    target_authorization_header:
      "blocked",

    missing_identity:
      "blocked"
  })
);
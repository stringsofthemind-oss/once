import assert from "node:assert/strict";
import http from "node:http";

import {
  HTTP_RESPONSE_REPLAY_V2_CONTRACT,
  HttpResponseReplayV2Error,
  captureHttpResponseReplayV2,
  reconstructHttpResponseReplayV2,
  validateHttpResponseReplayV2
} from "../dist/http-response-replay-v2.js";

console.log("");
console.log("ONCE HTTP RESPONSE REPLAY V2 CONTRACT");
console.log("=====================================");

const binaryBody =
  Uint8Array.from([
    0,
    255,
    1,
    2,
    3,
    128
  ]);

const server =
  http.createServer(
    (request, response) => {
      if (request.url === "/redirect") {
        response.statusCode = 302;
        response.setHeader(
          "location",
          "/binary"
        );
        response.end();
        return;
      }

      if (request.url === "/binary") {
        response.statusCode = 201;
        response.statusMessage =
          "Created By Once Contract";
        response.setHeader(
          "content-type",
          "application/octet-stream"
        );
        response.setHeader(
          "set-cookie",
          [
            "once-a=1; Path=/",
            "once-b=2; Path=/"
          ]
        );
        response.end(
          Buffer.from(binaryBody)
        );
        return;
      }

      if (request.url === "/json") {
        response.statusCode = 200;
        response.statusMessage = "OK";
        response.setHeader(
          "content-type",
          "application/json; charset=utf-8"
        );
        response.end(
          JSON.stringify({
            ok: true,
            source: "native-fetch"
          })
        );
        return;
      }

      if (request.url === "/empty") {
        response.statusCode = 204;
        response.statusMessage =
          "No Content";
        response.end();
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    }
  );

await new Promise(
  (resolve, reject) => {
    server.once("error", reject);
    server.listen(
      0,
      "127.0.0.1",
      resolve
    );
  }
);

try {
  const address =
    server.address();

  assert.ok(
    address &&
    typeof address !== "string"
  );

  const origin =
    `http://127.0.0.1:${address.port}`;

  const nativeResponse =
    await fetch(
      `${origin}/redirect`
    );

  const captureSource =
    nativeResponse.clone();

  const receipt =
    await captureHttpResponseReplayV2(
      captureSource
    );

  assert.equal(
    receipt.contract,
    HTTP_RESPONSE_REPLAY_V2_CONTRACT
  );
  assert.equal(
    receipt.status,
    nativeResponse.status
  );
  assert.equal(
    receipt.status_text,
    nativeResponse.statusText
  );
  assert.deepEqual(
    receipt.headers_entries,
    Array.from(
      nativeResponse.headers.entries()
    )
  );
  assert.equal(
    receipt.url,
    nativeResponse.url
  );
  assert.equal(
    receipt.redirected,
    true
  );
  assert.equal(
    receipt.redirected,
    nativeResponse.redirected
  );
  assert.equal(
    receipt.type,
    nativeResponse.type
  );
  assert.equal(
    receipt.body_present,
    true
  );
  assert.equal(
    receipt.body_length,
    binaryBody.byteLength
  );
  assert.deepEqual(
    Uint8Array.from(
      Buffer.from(
        receipt.body_base64,
        "base64"
      )
    ),
    binaryBody
  );

  console.log(
    "PASS - native fetch capture preserves status/statusText/headers/final URL/redirect/type"
  );
  console.log(
    "PASS - native fetch capture preserves exact binary response bytes"
  );

  const replay =
    reconstructHttpResponseReplayV2(
      receipt
    );

  assert.equal(
    replay instanceof Response,
    true
  );
  assert.equal(
    Object.prototype.toString.call(
      replay
    ),
    "[object Response]"
  );
  assert.equal(
    replay.status,
    nativeResponse.status
  );
  assert.equal(
    replay.statusText,
    nativeResponse.statusText
  );
  assert.equal(
    replay.ok,
    nativeResponse.ok
  );
  assert.equal(
    replay.url,
    nativeResponse.url
  );
  assert.equal(
    replay.redirected,
    nativeResponse.redirected
  );
  assert.equal(
    replay.type,
    nativeResponse.type
  );
  assert.deepEqual(
    Array.from(
      replay.headers.entries()
    ),
    Array.from(
      nativeResponse.headers.entries()
    )
  );
  assert.equal(
    replay.bodyUsed,
    false
  );
  assert.ok(
    replay.body instanceof ReadableStream
  );

  assert.throws(
    () => {
      nativeResponse.headers.set(
        "x-once-test",
        "forbidden"
      );
    },
    TypeError
  );

  assert.throws(
    () => {
      replay.headers.set(
        "x-once-test",
        "forbidden"
      );
    },
    TypeError
  );

  if (
    typeof nativeResponse.headers.getSetCookie ===
    "function" &&
    typeof replay.headers.getSetCookie ===
    "function"
  ) {
    assert.deepEqual(
      replay.headers.getSetCookie(),
      nativeResponse.headers.getSetCookie()
    );
  }

  console.log(
    "PASS - reconstructed response preserves native metadata and direct immutable-header behavior"
  );

  const replayClone =
    replay.clone();

  assert.equal(
    replayClone instanceof Response,
    true
  );
  assert.equal(
    replayClone.url,
    replay.url
  );
  assert.equal(
    replayClone.redirected,
    replay.redirected
  );
  assert.equal(
    replayClone.type,
    replay.type
  );
  assert.equal(
    replayClone.statusText,
    replay.statusText
  );

  assert.deepEqual(
    new Uint8Array(
      await replayClone.arrayBuffer()
    ),
    binaryBody
  );

  assert.equal(
    replayClone.bodyUsed,
    true
  );
  assert.equal(
    replay.bodyUsed,
    false
  );

  console.log(
    "PASS - clone preserves replay metadata and independently readable exact bytes"
  );

  const nativeText =
    await nativeResponse.text();

  const replayText =
    await replay.text();

  assert.equal(
    replayText,
    nativeText
  );
  assert.equal(
    replay.bodyUsed,
    true
  );
  assert.throws(
    () => replay.clone(),
    TypeError
  );

  console.log(
    "PASS - text() and bodyUsed/clone-after-consume behavior match native Response"
  );

  const lockedReplay =
    reconstructHttpResponseReplayV2(
      receipt
    );

  const reader =
    lockedReplay.body.getReader();

  assert.equal(
    lockedReplay.bodyUsed,
    false
  );
  assert.throws(
    () => lockedReplay.clone(),
    TypeError
  );
  reader.releaseLock();

  console.log(
    "PASS - native clone failure is preserved for a locked body stream"
  );

  const nativeJson =
    await fetch(
      `${origin}/json`
    );

  const jsonReceipt =
    await captureHttpResponseReplayV2(
      nativeJson.clone()
    );

  const jsonReplay =
    reconstructHttpResponseReplayV2(
      jsonReceipt
    );

  assert.deepEqual(
    await jsonReplay.clone().json(),
    await nativeJson.clone().json()
  );

  const replayBlob =
    await jsonReplay.clone().blob();

  const nativeBlob =
    await nativeJson.clone().blob();

  assert.equal(
    replayBlob.type,
    nativeBlob.type
  );
  assert.equal(
    replayBlob.size,
    nativeBlob.size
  );
  assert.equal(
    await replayBlob.text(),
    await nativeBlob.text()
  );

  assert.deepEqual(
    new Uint8Array(
      await jsonReplay.arrayBuffer()
    ),
    new Uint8Array(
      await nativeJson.arrayBuffer()
    )
  );

  console.log(
    "PASS - json(), blob(), and arrayBuffer() preserve the native body view"
  );

  const nativeEmpty =
    await fetch(
      `${origin}/empty`
    );

  const emptyReceipt =
    await captureHttpResponseReplayV2(
      nativeEmpty.clone()
    );

  assert.equal(
    emptyReceipt.body_present,
    false
  );
  assert.equal(
    emptyReceipt.body_length,
    0
  );

  const emptyReplay =
    reconstructHttpResponseReplayV2(
      emptyReceipt
    );

  assert.equal(
    emptyReplay.body,
    null
  );
  assert.equal(
    emptyReplay.status,
    204
  );
  assert.equal(
    (await emptyReplay.arrayBuffer()).byteLength,
    0
  );

  console.log(
    "PASS - native null-body response remains a null-body replay"
  );

  const valid =
    validateHttpResponseReplayV2(
      receipt
    );

  const invalidReceipts = [
    {
      label: "legacy text-only v1 receipt",
      value: {
        status: 200,
        body_text: "{}",
        headers: {}
      }
    },
    {
      label: "extra hidden field",
      value: {
        ...valid,
        hidden: true
      }
    },
    {
      label: "malformed base64",
      value: {
        ...valid,
        body_base64: "***"
      }
    },
    {
      label: "mismatched byte length",
      value: {
        ...valid,
        body_length:
          valid.body_length + 1
      }
    },
    {
      label: "opaque response type",
      value: {
        ...valid,
        type: "opaque"
      }
    },
    {
      label: "noncanonical header name",
      value: {
        ...valid,
        headers_entries: [
          [
            "X-Test",
            "1"
          ]
        ]
      }
    },
    {
      label: "credentialed URL",
      value: {
        ...valid,
        url:
          "https://user:pass@example.invalid/final"
      }
    },
    {
      label: "body bytes on a null-body status",
      value: {
        ...valid,
        status: 204,
        status_text:
          "No Content",
        body_present: true
      }
    }
  ];

  for (const invalid of invalidReceipts) {
    assert.throws(
      () =>
        validateHttpResponseReplayV2(
          invalid.value
        ),
      error =>
        error instanceof
        HttpResponseReplayV2Error,
      invalid.label
    );
  }

  console.log(
    "PASS - legacy/ambiguous/malformed response receipts fail closed under v2"
  );
  console.log(
    "PASS - v2 remains an internal contract; no transformer eligibility changed"
  );
}
finally {
  await new Promise(
    resolve =>
      server.close(resolve)
  );
}

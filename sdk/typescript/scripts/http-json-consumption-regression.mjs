import assert from "node:assert/strict";

import {
  executeHttpWriteJsonResponse
} from "../dist/http-response-json.js";

import {
  HTTP_JSON_CONSUMPTION_TRANSFORMER_ID,
  transformHttpJsonConsumptionV1
} from "../dist/transformers/http-json-consumption-v1.js";

import {
  transformHttpWriteV1
} from "../dist/transformers/http-write-v1.js";

const provider =
  "customer-http";

const targetUrl =
  "https://api.example.invalid/orders";

const functionSource = `
async function consequentialWrite(operationId, payload) {
}
`;

const capability = {
  name:
    provider,
  version_id:
    "provider-version-1",
  response_replay:
    "required",
  allowed_urls: [
    targetUrl
  ]
};

const consumedStatement = `
const result =
  await (
    await fetch(
      "https://api.example.invalid/orders",
      {
        method: "POST",
        body: JSON.stringify(payload)
      }
    )
  ).json();
`;

const oldTransformer =
  transformHttpWriteV1({
    statement:
      consumedStatement,
    functionSource,
    provider
  });

assert.equal(
  oldTransformer.eligible,
  false,
  "existing unused-response transformer boundary must remain unchanged"
);

const noCapability =
  transformHttpJsonConsumptionV1({
    statement:
      consumedStatement,
    functionSource,
    provider
  });

assert.equal(
  noCapability.eligible,
  false,
  "provider name alone must not enable response preservation"
);

const transformed =
  transformHttpJsonConsumptionV1({
    statement:
      consumedStatement,
    functionSource,
    provider,
    capability
  });

assert.equal(
  transformed.eligible,
  true,
  "immediate JSON consumption should be transformable with exact replay capability"
);

if (!transformed.eligible) {
  throw new Error(transformed.reason);
}

assert.equal(
  transformed.transformer,
  HTTP_JSON_CONSUMPTION_TRANSFORMER_ID
);

assert.equal(
  transformed.method,
  "POST"
);

assert.equal(
  transformed.url,
  targetUrl
);

assert.equal(
  transformed.bodyExpression,
  "payload"
);

assert.equal(
  transformed.resultIdentifier,
  "result"
);

assert.match(
  transformed.capabilityFingerprint,
  /^[a-f0-9]{64}$/
);

assert.match(
  transformed.replacement,
  /^const result = await executeHttpWriteJsonResponse\(\{/
);

assert.match(
  transformed.replacement,
  /operationId/
);

assert.match(
  transformed.replacement,
  /provider: "customer-http"/
);

assert.match(
  transformed.replacement,
  /type: "http_write_v1"/
);

assert.match(
  transformed.replacement,
  /method: "POST"/
);

assert.match(
  transformed.replacement,
  /body_json: JSON\.stringify\(payload\)/
);

assert.doesNotMatch(
  transformed.replacement,
  /\.json\(\)/,
  "JSON consumption must occur inside the replay helper exactly once"
);

const returnedResponse =
  transformHttpJsonConsumptionV1({
    statement: `
      return await fetch(
        "https://api.example.invalid/orders",
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );
    `,
    functionSource,
    provider,
    capability
  });

assert.equal(
  returnedResponse.eligible,
  false,
  "returned native Response must remain fail-closed"
);

const assignedResponse =
  transformHttpJsonConsumptionV1({
    statement: `
      const response = await fetch(
        "https://api.example.invalid/orders",
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );
    `,
    functionSource,
    provider,
    capability
  });

assert.equal(
  assignedResponse.eligible,
  false,
  "retained native Response must remain fail-closed"
);

const wrongUrlCapability =
  transformHttpJsonConsumptionV1({
    statement:
      consumedStatement,
    functionSource,
    provider,
    capability: {
      ...capability,
      allowed_urls: [
        "https://api.example.invalid/other"
      ]
    }
  });

assert.equal(
  wrongUrlCapability.eligible,
  false,
  "exact URL replay capability is required"
);

const wrongProviderCapability =
  transformHttpJsonConsumptionV1({
    statement:
      consumedStatement,
    functionSource,
    provider,
    capability: {
      ...capability,
      name:
        "different-provider"
    }
  });

assert.equal(
  wrongProviderCapability.eligible,
  false,
  "replay capability must be bound to the configured provider"
);

const putResponse =
  transformHttpJsonConsumptionV1({
    statement:
      consumedStatement.replace(
        'method: "POST"',
        'method: "PUT"'
      ),
    functionSource,
    provider,
    capability
  });

assert.equal(
  putResponse.eligible,
  false,
  "response replay transform is POST-only in v1"
);

const preservedHeader =
  transformHttpJsonConsumptionV1({
    statement:
      consumedStatement.replace(
        'method: "POST",',
        'method: "POST",\n        headers: {\n          "Content-Type": "application/json",\n          "X-API-Version": "2026-09-01"\n        },'
      ),
    functionSource,
    provider,
    capability
  });

assert.equal(
  preservedHeader.eligible,
  false,
  "richer preserved target headers remain fail-closed for response replay"
);

const authorization =
  transformHttpJsonConsumptionV1({
    statement:
      consumedStatement.replace(
        'method: "POST",',
        'method: "POST",\n        headers: {\n          "Authorization": "Bearer fixed-test-token"\n        },'
      ),
    functionSource,
    provider,
    capability
  });

assert.equal(
  authorization.eligible,
  false,
  "source Authorization must never enter response-preserving action generation"
);

const dynamicUrl =
  transformHttpJsonConsumptionV1({
    statement:
      consumedStatement.replace(
        '"https://api.example.invalid/orders"',
        "endpoint"
      ),
    functionSource,
    provider,
    capability
  });

assert.equal(
  dynamicUrl.eligible,
  false,
  "dynamic URL remains fail-closed"
);

const rawBody =
  transformHttpJsonConsumptionV1({
    statement:
      consumedStatement.replace(
        "JSON.stringify(payload)",
        "payload"
      ),
    functionSource,
    provider,
    capability
  });

assert.equal(
  rawBody.eligible,
  false,
  "raw body remains fail-closed"
);

let executeCalls = 0;

const replayFetch =
  async (input, init) => {
    executeCalls++;

    assert.match(
      String(input),
      /\/v1\/execute$/
    );

    const body =
      JSON.parse(String(init?.body));

    assert.equal(
      body.operation_id,
      "order:1"
    );

    assert.equal(
      body.provider,
      provider
    );

    assert.equal(
      body.action.type,
      "http_write_v1"
    );

    return new Response(
      JSON.stringify({
        operation_id:
          "order:1",
        result:
          "CONFIRMED",
        state:
          "CONFIRMED",
        http_response: {
          status: 201,
          body_text:
            JSON.stringify({
              created: true,
              id: "external-1"
            }),
          headers: {
            "content-type":
              "application/json"
          },
          recorded_at:
            "2026-09-30T15:00:00Z"
        }
      }),
      {
        status: 200,
        headers: {
          "content-type":
            "application/json"
        }
      }
    );
  };

const replayedJson =
  await executeHttpWriteJsonResponse(
    {
      operationId:
        "order:1",
      provider,
      action: {
        type:
          "http_write_v1",
        method:
          "POST",
        url:
          targetUrl,
        body_json:
          JSON.stringify({
            item: "book"
          })
      }
    },
    {
      apiKey:
        "test-key",
      baseUrl:
        "https://once.example.invalid",
      networkRetries:
        0,
      fetchImpl:
        replayFetch
    }
  );

assert.deepEqual(
  replayedJson,
  {
    created: true,
    id: "external-1"
  }
);

assert.equal(
  executeCalls,
  1
);

await assert.rejects(
  () =>
    executeHttpWriteJsonResponse(
      {
        operationId:
          "order:2",
        provider,
        action: {
          type:
            "not-http-write"
        }
      },
      {
        apiKey:
          "test-key",
        fetchImpl:
          replayFetch
      }
    ),
  error =>
    error?.code ===
      "invalid_http_response_action"
);

const invalidReplayFetch =
  async () =>
    new Response(
      JSON.stringify({
        operation_id:
          "order:3",
        result:
          "CONFIRMED",
        state:
          "CONFIRMED",
        http_response: {
          status: 201,
          body_text:
            "not-json",
          headers: {
            "content-type":
              "application/json"
          }
        }
      }),
      {
        status: 200,
        headers: {
          "content-type":
            "application/json"
        }
      }
    );

await assert.rejects(
  () =>
    executeHttpWriteJsonResponse(
      {
        operationId:
          "order:3",
        provider,
        action: {
          type:
            "http_write_v1",
          method:
            "POST",
          url:
            targetUrl,
          body_json:
            "{}"
        }
      },
      {
        apiKey:
          "test-key",
        networkRetries:
          0,
        fetchImpl:
          invalidReplayFetch
      }
    ),
  SyntaxError,
  "invalid replay body must reject like Response.json()"
);

console.log(
  "PASS - existing unused-response transformer boundary unchanged"
);
console.log(
  "PASS - immediate JSON response consumption requires exact replay capability"
);
console.log(
  "PASS - returned/retained Response shapes remain fail-closed"
);
console.log(
  "PASS - PUT/richer headers/Authorization/dynamic URL/raw body remain rejected"
);
console.log(
  "PASS - generated action preserves operationId/provider/POST/body_json"
);
console.log(
  "PASS - replay helper returns parsed recorded JSON without provider redispatch"
);
console.log(
  "PASS - invalid recorded JSON rejects with SyntaxError semantics"
);

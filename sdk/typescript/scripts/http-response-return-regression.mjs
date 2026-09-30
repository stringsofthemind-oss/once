import assert from "node:assert/strict";

import {
  createHash
} from "node:crypto";

import {
  transformHttpResponseReturnV1
} from "../dist/transformers/http-response-return-v1.js";

import {
  buildHttpResponseReturnPatchV1,
  HTTP_RESPONSE_RETURN_PATCH_PLAN_ID
} from "../dist/transformers/http-response-return-patch-plan-v1.js";

const publicHelper =
  await import(
    "@once-agent/sdk/http-response"
  );

assert.equal(
  typeof publicHelper.executeHttpWriteResponse,
  "function",
  "public native HTTP Response helper subpath must resolve"
);

const provider =
  "customer-http";

const targetUrl =
  "https://api.example.invalid/orders";

const capability = {
  name:
    provider,
  version_id:
    "provider-version-v2-return-1",
  response_replay:
    "required",
  response_replay_v2:
    "required",
  allowed_urls: [
    targetUrl
  ]
};

const legacyCapability = {
  name:
    provider,
  version_id:
    "provider-version-v1-only",
  response_replay:
    "required",
  allowed_urls: [
    targetUrl
  ]
};

const statement = `return await fetch(
    "https://api.example.invalid/orders",
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );`;

const source = `
"use strict";

export async function createOrder(operationId, payload) {
  ${statement}
}
`.trimStart();

const functionSource = `
export async function createOrder(operationId, payload) {
}
`;

const transformed =
  transformHttpResponseReturnV1({
    statement,
    functionSource,
    provider,
    capability
  });

assert.equal(
  transformed.eligible,
  true,
  "exact returned-response shape with replay-v2 capability should transform"
);

if (!transformed.eligible) {
  throw new Error(transformed.reason);
}

assert.equal(
  transformed.transformer,
  "ts_fetch_response_return_v1"
);
assert.equal(
  transformed.url,
  targetUrl
);
assert.match(
  transformed.replacement,
  /^return await executeHttpWriteResponse\(\{/
);

const v1Only =
  transformHttpResponseReturnV1({
    statement,
    functionSource,
    provider,
    capability:
      legacyCapability
  });

assert.equal(
  v1Only.eligible,
  false,
  "v1 text replay capability must not qualify a returned native Response"
);
assert.match(
  v1Only.reason,
  /replay v2/i
);

for (const unsupportedStatement of [
  `return fetch("${targetUrl}", { method: "POST", body: JSON.stringify(payload) });`,
  `return (await fetch("${targetUrl}", { method: "POST", body: JSON.stringify(payload) })).json();`,
  `if (payload) return await fetch("${targetUrl}", { method: "POST", body: JSON.stringify(payload) });`,
  `const response = await fetch("${targetUrl}", { method: "POST", body: JSON.stringify(payload) });`
]) {
  const unsupported =
    transformHttpResponseReturnV1({
      statement:
        unsupportedStatement,
      functionSource,
      provider,
      capability
    });

  assert.equal(
    unsupported.eligible,
    false,
    `unsupported return shape must remain fail-closed: ${unsupportedStatement}`
  );
}

const noCapability =
  transformHttpResponseReturnV1({
    statement,
    functionSource,
    provider
  });

assert.equal(
  noCapability.eligible,
  false,
  "returned native Response transformation requires explicit capability evidence"
);

const patch =
  buildHttpResponseReturnPatchV1({
    source,
    statement,
    functionSource,
    provider,
    capability
  });

assert.equal(
  patch.eligible,
  true,
  "known-safe returned native Response source should produce a patch plan"
);

if (!patch.eligible) {
  throw new Error(patch.reason);
}

assert.equal(
  patch.patchPlan,
  HTTP_RESPONSE_RETURN_PATCH_PLAN_ID
);
assert.equal(
  patch.transformerId,
  "ts_fetch_response_return_v1"
);
assert.equal(
  patch.bindingStrategy,
  "http-response-helper-import"
);
assert.equal(
  patch.targetUrl,
  targetUrl
);
assert.equal(
  patch.sourceSha256,
  createHash("sha256")
    .update(source, "utf8")
    .digest("hex")
);
assert.equal(
  patch.proposedSourceSha256,
  createHash("sha256")
    .update(
      patch.proposedSource,
      "utf8"
    )
    .digest("hex")
);
assert.match(
  patch.capabilityFingerprint,
  /^[a-f0-9]{64}$/
);
assert.match(
  patch.proposedSource,
  /@once-agent\/sdk\/http-response/
);
assert.match(
  patch.proposedSource,
  /return await __OnceAgentHttpResponse\(\{/
);
assert.doesNotMatch(
  patch.proposedSource,
  /return\s+await\s+fetch\s*\(/
);

const duplicate =
  buildHttpResponseReturnPatchV1({
    source:
      `${source}\n${statement}\n`,
    statement,
    functionSource,
    provider,
    capability
  });

assert.equal(
  duplicate.eligible,
  false,
  "ambiguous duplicate returned-response target must fail closed"
);

const nonStandaloneSource =
  `export async function createOrder(operationId, payload) { ${statement} }\n`;

const nonStandalone =
  buildHttpResponseReturnPatchV1({
    source:
      nonStandaloneSource,
    statement,
    functionSource,
    provider,
    capability
  });

assert.equal(
  nonStandalone.eligible,
  false,
  "non-standalone returned-response target must fail closed"
);

console.log(
  "PASS - exact `return await fetch(...)` shape is capability-gated by replay-v2"
);
console.log(
  "PASS - legacy v1-only replay and unsupported return shapes remain fail-closed"
);
console.log(
  "PASS - returned native Response patch uses the existing deterministic helper binding"
);
console.log(
  "PASS - source/proposed fingerprints are deterministic and direct fetch is removed"
);
console.log(
  "PASS - duplicate and non-standalone return targets fail closed"
);

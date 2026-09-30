import assert from "node:assert/strict";

import {
  createHash
} from "node:crypto";

import {
  transformHttpResponseAssignmentV1
} from "../dist/transformers/http-response-assignment-v1.js";

import {
  bindHttpResponseHelperV1,
  HTTP_RESPONSE_HELPER_ALIAS,
  HTTP_RESPONSE_HELPER_IMPORT
} from "../dist/transformers/http-response-binding-v1.js";

import {
  buildHttpResponsePatchV1,
  HTTP_RESPONSE_PATCH_PLAN_ID
} from "../dist/transformers/http-response-patch-plan-v1.js";

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
    "provider-version-v2-1",
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

const statement = `const response =
    await fetch(
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
  if (!response.ok) throw new Error(String(response.status));
  const clone = response.clone();
  return {
    body: await response.json(),
    echoed: await clone.text(),
    url: response.url,
    redirected: response.redirected,
    type: response.type
  };
}
`.trimStart();

const functionSource = `
export async function createOrder(operationId, payload) {
}
`;

const transformed =
  transformHttpResponseAssignmentV1({
    statement,
    functionSource,
    provider,
    capability
  });

assert.equal(
  transformed.eligible,
  true,
  "exact const assigned-response shape with replay-v2 capability should transform"
);

if (!transformed.eligible) {
  throw new Error(transformed.reason);
}

assert.equal(
  transformed.transformer,
  "ts_fetch_response_assignment_v1"
);
assert.equal(
  transformed.responseIdentifier,
  "response"
);
assert.equal(
  transformed.url,
  targetUrl
);
assert.match(
  transformed.replacement,
  /^const response = await executeHttpWriteResponse\(\{/
);

const v1Only =
  transformHttpResponseAssignmentV1({
    statement,
    functionSource,
    provider,
    capability:
      legacyCapability
  });

assert.equal(
  v1Only.eligible,
  false,
  "v1 text replay capability must not qualify a retained native Response"
);
assert.match(
  v1Only.reason,
  /replay v2/i
);

for (const unsupportedStatement of [
  statement.replace(/^const /, "let "),
  statement.replace(/^const /, "var "),
  `return await fetch("${targetUrl}", { method: "POST", body: JSON.stringify(payload) });`,
  `const response = fetch("${targetUrl}", { method: "POST", body: JSON.stringify(payload) });`,
  `target.response = await fetch("${targetUrl}", { method: "POST", body: JSON.stringify(payload) });`
]) {
  const unsupported =
    transformHttpResponseAssignmentV1({
      statement:
        unsupportedStatement,
      functionSource,
      provider,
      capability
    });

  assert.equal(
    unsupported.eligible,
    false,
    `unsupported response shape must remain fail-closed: ${unsupportedStatement.split("\n")[0]}`
  );
}

const rawReplacement = transformed.replacement;

const binding =
  bindHttpResponseHelperV1(
    source,
    rawReplacement
  );

assert.equal(
  binding.eligible,
  true,
  "known-safe ESM native Response binding should succeed"
);

if (!binding.eligible) {
  throw new Error(binding.reason);
}

assert.equal(
  binding.importStatement,
  HTTP_RESPONSE_HELPER_IMPORT
);
assert.equal(
  binding.helperAlias,
  HTTP_RESPONSE_HELPER_ALIAS
);
assert.match(
  binding.sourceWithImport,
  /^"use strict";\nimport \{ executeHttpWriteResponse as __OnceAgentHttpResponse \} from "@once-agent\/sdk\/http-response";/
);
assert.match(
  binding.boundReplacement,
  /const response = await __OnceAgentHttpResponse\(\{/
);
assert.doesNotMatch(
  binding.boundReplacement,
  /executeHttpWriteResponse\s*\(/
);

const patch =
  buildHttpResponsePatchV1({
    source,
    statement,
    functionSource,
    provider,
    capability
  });

assert.equal(
  patch.eligible,
  true,
  "known-safe assigned native Response source should produce a patch plan"
);

if (!patch.eligible) {
  throw new Error(patch.reason);
}

assert.equal(
  patch.patchPlan,
  HTTP_RESPONSE_PATCH_PLAN_ID
);
assert.equal(
  patch.transformerId,
  "ts_fetch_response_assignment_v1"
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
  /const response = await __OnceAgentHttpResponse\(\{/
);
assert.match(
  patch.proposedSource,
  /response\.clone\(\)/
);
assert.match(
  patch.proposedSource,
  /response\.url/
);
assert.doesNotMatch(
  patch.proposedSource,
  /await\s+fetch\s*\(/
);

const duplicate =
  buildHttpResponsePatchV1({
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
  "ambiguous duplicate assigned-response target must fail closed"
);

const aliasCollision =
  bindHttpResponseHelperV1(
    `export const ${HTTP_RESPONSE_HELPER_ALIAS} = 1;\n`,
    rawReplacement
  );

assert.equal(
  aliasCollision.eligible,
  false,
  "reserved native Response helper alias collision must fail closed"
);

const nonEsm =
  bindHttpResponseHelperV1(
    "async function createOrder() {}\n",
    rawReplacement
  );

assert.equal(
  nonEsm.eligible,
  false,
  "non-ESM automatic native Response binding must fail closed"
);

const twoCalls =
  bindHttpResponseHelperV1(
    source,
    `${rawReplacement}\n${rawReplacement}`
  );

assert.equal(
  twoCalls.eligible,
  false,
  "multiple generated native Response helper calls must fail closed"
);

console.log(
  "PASS - exact const assigned-response shape is capability-gated by replay-v2"
);
console.log(
  "PASS - legacy v1-only replay and unsupported response shapes remain fail-closed"
);
console.log(
  "PASS - one deterministic native Response helper import preserves the assigned binding"
);
console.log(
  "PASS - patch plan preserves downstream Response usage while removing direct fetch"
);
console.log(
  "PASS - duplicate target, alias collision, non-ESM, and multiple calls fail closed"
);

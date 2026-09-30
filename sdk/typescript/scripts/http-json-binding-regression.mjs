import assert from "node:assert/strict";

import {
  createHash
} from "node:crypto";

import {
  bindHttpJsonHelperV1,
  HTTP_JSON_HELPER_ALIAS,
  HTTP_JSON_HELPER_IMPORT
} from "../dist/transformers/http-json-binding-v1.js";

import {
  buildHttpJsonPatchV1,
  HTTP_JSON_PATCH_PLAN_ID
} from "../dist/transformers/http-json-patch-plan-v1.js";

const publicHelper =
  await import(
    "@once-agent/sdk/http-response-json"
  );

assert.equal(
  typeof publicHelper.executeHttpWriteJsonResponse,
  "function",
  "public HTTP JSON helper subpath must resolve"
);

const provider =
  "customer-http";

const targetUrl =
  "https://api.example.invalid/orders";

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

const statement = `const result =
    await (
      await fetch(
        "https://api.example.invalid/orders",
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      )
    ).json();`;

const source = `
"use strict";

export async function createOrder(operationId, payload) {
  ${statement}
  return result;
}
`.trimStart();

const functionSource = `
export async function createOrder(operationId, payload) {
}
`;

const rawReplacement = `const result = await executeHttpWriteJsonResponse({
  operationId,
  provider: "customer-http",
  action: {
    type: "http_write_v1",
    method: "POST",
    url: "https://api.example.invalid/orders",
    body_json: JSON.stringify(payload)
  }
});`;

const binding =
  bindHttpJsonHelperV1(
    source,
    rawReplacement
  );

assert.equal(
  binding.eligible,
  true,
  "known-safe ESM binding should succeed"
);

if (!binding.eligible) {
  throw new Error(binding.reason);
}

assert.equal(
  binding.importStatement,
  HTTP_JSON_HELPER_IMPORT
);

assert.equal(
  binding.helperAlias,
  HTTP_JSON_HELPER_ALIAS
);

assert.match(
  binding.sourceWithImport,
  /^"use strict";\nimport \{ executeHttpWriteJsonResponse as __OnceAgentHttpJson \} from "@once-agent\/sdk\/http-response-json";/
);

assert.match(
  binding.boundReplacement,
  /await __OnceAgentHttpJson\(\{/
);

assert.doesNotMatch(
  binding.boundReplacement,
  /executeHttpWriteJsonResponse\s*\(/
);

const patch =
  buildHttpJsonPatchV1({
    source,
    statement,
    functionSource,
    provider,
    capability
  });

assert.equal(
  patch.eligible,
  true,
  "known-safe JSON response source should produce a patch plan"
);

if (!patch.eligible) {
  throw new Error(patch.reason);
}

assert.equal(
  patch.patchPlan,
  HTTP_JSON_PATCH_PLAN_ID
);

assert.equal(
  patch.transformerId,
  "ts_fetch_json_consumption_v1"
);

assert.equal(
  patch.bindingStrategy,
  "http-json-helper-import"
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
  /@once-agent\/sdk\/http-response-json/
);

assert.match(
  patch.proposedSource,
  /const result = await __OnceAgentHttpJson\(\{/
);

assert.match(
  patch.proposedSource,
  /return result;/
);

assert.doesNotMatch(
  patch.proposedSource,
  /await\s+fetch\s*\(/
);

const noCapability =
  buildHttpJsonPatchV1({
    source,
    statement,
    functionSource,
    provider
  });

assert.equal(
  noCapability.eligible,
  false,
  "patch plan requires explicit replay capability"
);

const duplicateSource =
  `${source}\n${statement}\n`;

const duplicate =
  buildHttpJsonPatchV1({
    source:
      duplicateSource,
    statement,
    functionSource,
    provider,
    capability
  });

assert.equal(
  duplicate.eligible,
  false,
  "ambiguous duplicate target must fail closed"
);

const aliasCollision =
  bindHttpJsonHelperV1(
    `export const ${HTTP_JSON_HELPER_ALIAS} = 1;\n`,
    rawReplacement
  );

assert.equal(
  aliasCollision.eligible,
  false,
  "reserved helper alias collision must fail closed"
);

const nonEsm =
  bindHttpJsonHelperV1(
    "async function createOrder() {}\n",
    rawReplacement
  );

assert.equal(
  nonEsm.eligible,
  false,
  "non-ESM automatic binding must fail closed"
);

const twoCalls =
  bindHttpJsonHelperV1(
    source,
    rawReplacement +
      "\n" +
      rawReplacement
  );

assert.equal(
  twoCalls.eligible,
  false,
  "multiple generated helper calls must fail closed"
);

console.log(
  "PASS - public @once-agent/sdk/http-response-json subpath resolves"
);
console.log(
  "PASS - helper binding inserts one deterministic reserved import"
);
console.log(
  "PASS - response-consuming fetch is transactionally replaced in proposed source"
);
console.log(
  "PASS - source/proposed fingerprints are deterministic"
);
console.log(
  "PASS - missing capability, duplicate target, alias collision, non-ESM, and multiple calls fail closed"
);

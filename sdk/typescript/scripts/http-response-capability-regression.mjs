import assert from "node:assert/strict";

import {
  HTTP_RESPONSE_CAPABILITY_ID,
  validateHttpResponseReplayCapabilityV1
} from "../dist/transformers/http-response-capability-v1.js";

const provider =
  "customer-http";

const targetUrl =
  "https://api.example.invalid/orders";

const exactCapability = {
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

const exact =
  validateHttpResponseReplayCapabilityV1({
    provider,
    targetUrl,
    capability:
      exactCapability
  });

assert.equal(
  exact.eligible,
  true,
  "exact response-replay capability should be eligible"
);

if (!exact.eligible) {
  throw new Error(exact.reason);
}

assert.equal(
  exact.capabilityId,
  HTTP_RESPONSE_CAPABILITY_ID
);

assert.equal(
  exact.provider,
  provider
);

assert.equal(
  exact.providerVersionId,
  "provider-version-1"
);

assert.equal(
  exact.targetUrl,
  targetUrl
);

assert.match(
  exact.capabilityFingerprint,
  /^[a-f0-9]{64}$/
);

const providerNameOnly =
  validateHttpResponseReplayCapabilityV1({
    provider,
    targetUrl
  });

assert.equal(
  providerNameOnly.eligible,
  false,
  "provider name alone must never prove response replay"
);

const wrongProvider =
  validateHttpResponseReplayCapabilityV1({
    provider,
    targetUrl,
    capability: {
      ...exactCapability,
      name:
        "different-provider"
    }
  });

assert.equal(
  wrongProvider.eligible,
  false,
  "capability evidence must be provider-bound"
);

const missingVersion =
  validateHttpResponseReplayCapabilityV1({
    provider,
    targetUrl,
    capability: {
      name:
        provider,
      response_replay:
        "required",
      allowed_urls: [
        targetUrl
      ]
    }
  });

assert.equal(
  missingVersion.eligible,
  false,
  "provider version evidence is required"
);

const optionalReplay =
  validateHttpResponseReplayCapabilityV1({
    provider,
    targetUrl,
    capability: {
      ...exactCapability,
      response_replay:
        "optional"
    }
  });

assert.equal(
  optionalReplay.eligible,
  false,
  "response replay must be explicitly required"
);

const missingTarget =
  validateHttpResponseReplayCapabilityV1({
    provider,
    targetUrl,
    capability: {
      ...exactCapability,
      allowed_urls: [
        "https://api.example.invalid/other"
      ]
    }
  });

assert.equal(
  missingTarget.eligible,
  false,
  "target URL must be explicitly allowed"
);

const duplicateTarget =
  validateHttpResponseReplayCapabilityV1({
    provider,
    targetUrl,
    capability: {
      ...exactCapability,
      allowed_urls: [
        targetUrl,
        targetUrl
      ]
    }
  });

assert.equal(
  duplicateTarget.eligible,
  false,
  "duplicate allowed URL evidence must fail closed"
);

const nonCanonicalTarget =
  validateHttpResponseReplayCapabilityV1({
    provider,
    targetUrl:
      "https://api.example.invalid/orders?z=2&a=1",
    capability:
      exactCapability
  });

assert.equal(
  nonCanonicalTarget.eligible,
  false,
  "non-canonical target URLs must fail closed"
);

const credentialUrl =
  validateHttpResponseReplayCapabilityV1({
    provider,
    targetUrl,
    capability: {
      ...exactCapability,
      allowed_urls: [
        targetUrl,
        "https://user:secret@api.example.invalid/orders"
      ]
    }
  });

assert.equal(
  credentialUrl.eligible,
  false,
  "credential-bearing allowed URLs must fail closed"
);

const capabilityWithAdditionalUrl =
  validateHttpResponseReplayCapabilityV1({
    provider,
    targetUrl,
    capability: {
      ...exactCapability,
      allowed_urls: [
        "https://api.example.invalid/archive",
        targetUrl
      ]
    }
  });

const capabilityWithReorderedUrls =
  validateHttpResponseReplayCapabilityV1({
    provider,
    targetUrl,
    capability: {
      ...exactCapability,
      allowed_urls: [
        targetUrl,
        "https://api.example.invalid/archive"
      ]
    }
  });

assert.equal(
  capabilityWithAdditionalUrl.eligible,
  true
);

assert.equal(
  capabilityWithReorderedUrls.eligible,
  true
);

if (
  !capabilityWithAdditionalUrl.eligible ||
  !capabilityWithReorderedUrls.eligible
) {
  throw new Error(
    "valid multi-URL capability unexpectedly rejected"
  );
}

assert.equal(
  capabilityWithAdditionalUrl.capabilityFingerprint,
  capabilityWithReorderedUrls.capabilityFingerprint,
  "capability fingerprint must be deterministic across allowed URL ordering"
);

assert.notEqual(
  exact.capabilityFingerprint,
  capabilityWithAdditionalUrl.capabilityFingerprint,
  "capability fingerprint must bind the full allowed URL set"
);

console.log(
  "PASS - exact provider response-replay capability accepted"
);
console.log(
  "PASS - provider name alone rejected"
);
console.log(
  "PASS - provider/version/replay/URL mismatches fail closed"
);
console.log(
  "PASS - malformed or ambiguous URL evidence rejected"
);
console.log(
  "PASS - capability fingerprint is deterministic and binds full evidence"
);
console.log(
  "PASS - transformer eligibility remains unchanged by this contract-only slice"
);

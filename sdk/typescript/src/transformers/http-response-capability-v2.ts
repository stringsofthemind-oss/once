import { createHash } from "node:crypto";

import {
  validateHttpResponseReplayCapabilityV1
} from "./http-response-capability-v1.js";

export const HTTP_RESPONSE_CAPABILITY_V2_ID =
  "http_response_replay_capability_v2" as const;

export type HttpResponseReplayCapabilityV2Input = {
  provider: string;
  targetUrl: string;
  capability?: unknown;
};

export type HttpResponseReplayCapabilityV2Success = {
  eligible: true;
  capabilityId:
    typeof HTTP_RESPONSE_CAPABILITY_V2_ID;
  provider: string;
  providerVersionId: string;
  targetUrl: string;
  capabilityFingerprint: string;
};

export type HttpResponseReplayCapabilityV2Failure = {
  eligible: false;
  reason: string;
};

export type HttpResponseReplayCapabilityV2Result =
  | HttpResponseReplayCapabilityV2Success
  | HttpResponseReplayCapabilityV2Failure;

function sha256(
  value: string
): string {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

export function validateHttpResponseReplayCapabilityV2(
  input: HttpResponseReplayCapabilityV2Input
): HttpResponseReplayCapabilityV2Result {
  const base =
    validateHttpResponseReplayCapabilityV1(input);

  if (!base.eligible) {
    return base;
  }

  const capability =
    input.capability as Record<string, unknown>;

  if (
    capability.response_replay_v2 !==
      "required"
  ) {
    return {
      eligible: false,
      reason:
        "Byte-exact native Response replay v2 must be explicitly required."
    };
  }

  const canonicalEvidence =
    JSON.stringify({
      base_capability_fingerprint:
        base.capabilityFingerprint,
      response_replay_v2:
        "required"
    });

  return {
    eligible: true,
    capabilityId:
      HTTP_RESPONSE_CAPABILITY_V2_ID,
    provider:
      base.provider,
    providerVersionId:
      base.providerVersionId,
    targetUrl:
      base.targetUrl,
    capabilityFingerprint:
      sha256(canonicalEvidence)
  };
}

import { createHash } from "node:crypto";

export const HTTP_RESPONSE_CAPABILITY_ID =
  "http_response_replay_capability_v1" as const;

export type HttpResponseReplayCapabilityEvidence = {
  name?: unknown;
  version_id?: unknown;
  response_replay?: unknown;
  allowed_urls?: unknown;
  [key: string]: unknown;
};

export type HttpResponseReplayCapabilityInput = {
  provider: string;
  targetUrl: string;
  capability?: unknown;
};

export type HttpResponseReplayCapabilitySuccess = {
  eligible: true;
  capabilityId:
    typeof HTTP_RESPONSE_CAPABILITY_ID;
  provider: string;
  providerVersionId: string;
  targetUrl: string;
  capabilityFingerprint: string;
};

export type HttpResponseReplayCapabilityFailure = {
  eligible: false;
  reason: string;
};

export type HttpResponseReplayCapabilityResult =
  | HttpResponseReplayCapabilitySuccess
  | HttpResponseReplayCapabilityFailure;

function sha256(
  value: string
): string {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const prototype =
    Object.getPrototypeOf(value);

  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function isCanonicalHttpsUrl(
  value: string
): boolean {
  let parsed: URL;

  try {
    parsed = new URL(value);
  }
  catch {
    return false;
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    return false;
  }

  parsed.searchParams.sort();

  return parsed.toString() === value;
}

export function validateHttpResponseReplayCapabilityV1(
  input: HttpResponseReplayCapabilityInput
): HttpResponseReplayCapabilityResult {
  const provider =
    input.provider.trim();

  if (!provider) {
    return {
      eligible: false,
      reason:
        "A configured provider is required."
    };
  }

  const targetUrl =
    input.targetUrl.trim();

  if (!isCanonicalHttpsUrl(targetUrl)) {
    return {
      eligible: false,
      reason:
        "Response-preserving HTTP protection requires an exact canonical HTTPS target URL."
    };
  }

  if (!isPlainObject(input.capability)) {
    return {
      eligible: false,
      reason:
        "Explicit provider response-replay capability evidence is required."
    };
  }

  const evidence =
    input.capability as HttpResponseReplayCapabilityEvidence;

  const evidenceProvider =
    typeof evidence.name === "string"
      ? evidence.name.trim()
      : "";

  if (
    !evidenceProvider ||
    evidenceProvider !== provider
  ) {
    return {
      eligible: false,
      reason:
        "Response-replay capability evidence must be bound to the exact configured provider."
    };
  }

  const providerVersionId =
    typeof evidence.version_id === "string"
      ? evidence.version_id.trim()
      : "";

  if (!providerVersionId) {
    return {
      eligible: false,
      reason:
        "Response-replay capability evidence must include a provider version ID."
    };
  }

  if (
    evidence.response_replay !==
      "required"
  ) {
    return {
      eligible: false,
      reason:
        "Provider response replay must be explicitly required."
    };
  }

  if (!Array.isArray(evidence.allowed_urls)) {
    return {
      eligible: false,
      reason:
        "Response-replay capability evidence must include exact allowed URLs."
    };
  }

  const allowedUrls =
    evidence.allowed_urls;

  if (allowedUrls.length === 0) {
    return {
      eligible: false,
      reason:
        "Response-replay capability evidence must include at least one allowed URL."
    };
  }

  const normalizedUrls: string[] = [];
  const seen = new Set<string>();

  for (const candidate of allowedUrls) {
    if (
      typeof candidate !== "string" ||
      !isCanonicalHttpsUrl(candidate)
    ) {
      return {
        eligible: false,
        reason:
          "Every response-replay allowed URL must be an exact canonical HTTPS URL."
      };
    }

    if (seen.has(candidate)) {
      return {
        eligible: false,
        reason:
          "Duplicate response-replay allowed URLs are not accepted as capability evidence."
      };
    }

    seen.add(candidate);
    normalizedUrls.push(candidate);
  }

  if (!seen.has(targetUrl)) {
    return {
      eligible: false,
      reason:
        "The protected target URL is not explicitly allowed for provider response replay."
    };
  }

  const canonicalEvidence =
    JSON.stringify({
      provider,
      version_id:
        providerVersionId,
      response_replay:
        "required",
      allowed_urls:
        [...normalizedUrls].sort()
    });

  return {
    eligible: true,
    capabilityId:
      HTTP_RESPONSE_CAPABILITY_ID,
    provider,
    providerVersionId,
    targetUrl,
    capabilityFingerprint:
      sha256(canonicalEvidence)
  };
}

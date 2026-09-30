import { createHash } from "node:crypto";

export const HTTP_BODY_CAPABILITY_ID =
  "http_bodyinit_capability_v1" as const;

export type HttpBodyCapabilityEvidence = {
  name?: unknown;
  version_id?: unknown;
  body_transport?: unknown;
  allowed_urls?: unknown;
  [key: string]: unknown;
};

export type HttpBodyCapabilityInput = {
  provider: string;
  targetUrl: string;
  capability?: unknown;
};

export type HttpBodyCapabilitySuccess = {
  eligible: true;
  capabilityId:
    typeof HTTP_BODY_CAPABILITY_ID;
  provider: string;
  providerVersionId: string;
  targetUrl: string;
  capabilityFingerprint: string;
};

export type HttpBodyCapabilityFailure = {
  eligible: false;
  reason: string;
};

export type HttpBodyCapabilityResult =
  | HttpBodyCapabilitySuccess
  | HttpBodyCapabilityFailure;

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

/**
 * Proves only that a registered provider explicitly advertises
 * the future BodyInit v1 execution contract for the exact target.
 *
 * This is NOT transformer eligibility. The generic raw-body source
 * shape remains rejected until runtime BodyInit coverage and the
 * provider/server execution contract are both complete.
 */
export function validateHttpBodyCapabilityV1(
  input: HttpBodyCapabilityInput
): HttpBodyCapabilityResult {
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
        "BodyInit HTTP protection requires an exact canonical HTTPS target URL."
    };
  }

  if (!isPlainObject(input.capability)) {
    return {
      eligible: false,
      reason:
        "Explicit provider BodyInit capability evidence is required."
    };
  }

  const evidence =
    input.capability as HttpBodyCapabilityEvidence;

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
        "BodyInit capability evidence must be bound to the exact configured provider."
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
        "BodyInit capability evidence must include a provider version ID."
    };
  }

  if (
    evidence.body_transport !==
      "bodyinit_v1"
  ) {
    return {
      eligible: false,
      reason:
        "Provider byte/body transport must explicitly advertise bodyinit_v1."
    };
  }

  if (!Array.isArray(evidence.allowed_urls)) {
    return {
      eligible: false,
      reason:
        "BodyInit capability evidence must include exact allowed URLs."
    };
  }

  if (
    evidence.allowed_urls.length === 0
  ) {
    return {
      eligible: false,
      reason:
        "BodyInit capability evidence must include at least one allowed URL."
    };
  }

  const normalizedUrls: string[] = [];
  const seen =
    new Set<string>();

  for (
    const candidate
    of evidence.allowed_urls
  ) {
    if (
      typeof candidate !== "string" ||
      !isCanonicalHttpsUrl(candidate)
    ) {
      return {
        eligible: false,
        reason:
          "Every BodyInit allowed URL must be an exact canonical HTTPS URL."
      };
    }

    if (seen.has(candidate)) {
      return {
        eligible: false,
        reason:
          "Duplicate BodyInit allowed URLs are not accepted as capability evidence."
      };
    }

    seen.add(candidate);
    normalizedUrls.push(candidate);
  }

  if (!seen.has(targetUrl)) {
    return {
      eligible: false,
      reason:
        "The protected target URL is not explicitly allowed for provider BodyInit execution."
    };
  }

  const canonicalEvidence =
    JSON.stringify({
      provider,
      version_id:
        providerVersionId,
      body_transport:
        "bodyinit_v1",
      allowed_urls:
        [...normalizedUrls].sort()
    });

  return {
    eligible: true,
    capabilityId:
      HTTP_BODY_CAPABILITY_ID,
    provider,
    providerVersionId,
    targetUrl,
    capabilityFingerprint:
      sha256(canonicalEvidence)
  };
}

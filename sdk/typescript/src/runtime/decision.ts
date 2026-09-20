export type OnceRuntimeDecision =
  | "PASS"
  | "PROTECT"
  | "BLOCK";

export type OnceRuntimeDecisionCode =
  | "SAFE_HTTP_METHOD"
  | "CONSEQUENTIAL_HTTP_WRITE"
  | "INVALID_URL"
  | "UNSUPPORTED_PROTOCOL"
  | "UNSUPPORTED_HTTP_METHOD"
  | "MISSING_PROVIDER"
  | "MISSING_OPERATION_ID";

export type OnceRuntimeHttpCall = {
  surface: "http";
  method: string;
  url: string;

  /**
   * Stable identity for one real-world action.
   *
   * Retries of that same action MUST reuse
   * the same value.
   */
  operationId?: string;

  /**
   * Once provider configured to perform /
   * reconcile this external side effect.
   */
  provider?: string;
};

export type OnceRuntimeDecisionResult = {
  decision: OnceRuntimeDecision;
  code: OnceRuntimeDecisionCode;
  consequential: boolean;
  method: string;
  reason: string;
};

const SAFE_HTTP_METHODS =
  new Set([
    "GET",
    "HEAD",
    "OPTIONS"
  ]);

const CONSEQUENTIAL_HTTP_METHODS =
  new Set([
    "POST",
    "PUT",
    "PATCH",
    "DELETE"
  ]);

function normalizeMethod(
  method: string
): string {

  return String(
    method || ""
  )
    .trim()
    .toUpperCase();
}

function nonEmpty(
  value: string | undefined
): boolean {

  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

/**
 * Decide whether an outbound HTTP operation may
 * pass normally, must be protected by Once, or
 * must fail closed.
 *
 * v0.1 intentionally does NOT guess identity.
 *
 * A consequential operation without a stable
 * operationId is blocked rather than executed
 * unsafely.
 */
export function decideHttpExecution(
  call: OnceRuntimeHttpCall
): OnceRuntimeDecisionResult {

  const method =
    normalizeMethod(
      call.method
    );

  let parsedUrl: URL;

  try {

    parsedUrl =
      new URL(
        call.url
      );

  } catch {

    return {
      decision:
        "BLOCK",

      code:
        "INVALID_URL",

      consequential:
        true,

      method,

      reason:
        "Runtime could not safely determine the destination URL."
    };
  }

  if (
    parsedUrl.protocol !== "https:" &&
    parsedUrl.protocol !== "http:"
  ) {

    return {
      decision:
        "BLOCK",

      code:
        "UNSUPPORTED_PROTOCOL",

      consequential:
        true,

      method,

      reason:
        `Runtime does not support protocol ${parsedUrl.protocol}`
    };
  }

  if (
    SAFE_HTTP_METHODS.has(
      method
    )
  ) {

    return {
      decision:
        "PASS",

      code:
        "SAFE_HTTP_METHOD",

      consequential:
        false,

      method,

      reason:
        `${method} is treated as a non-consequential HTTP read in Runtime v0.1.`
    };
  }

  if (
    !CONSEQUENTIAL_HTTP_METHODS.has(
      method
    )
  ) {

    return {
      decision:
        "BLOCK",

      code:
        "UNSUPPORTED_HTTP_METHOD",

      consequential:
        true,

      method,

      reason:
        `Runtime does not yet have a proven execution policy for HTTP method ${method || "(empty)"}.`
    };
  }

  if (
    !nonEmpty(
      call.provider
    )
  ) {

    return {
      decision:
        "BLOCK",

      code:
        "MISSING_PROVIDER",

      consequential:
        true,

      method,

      reason:
        "Consequential operation has no configured Once provider."
    };
  }

  if (
    !nonEmpty(
      call.operationId
    )
  ) {

    return {
      decision:
        "BLOCK",

      code:
        "MISSING_OPERATION_ID",

      consequential:
        true,

      method,

      reason:
        "Consequential operation has no stable operation identity. Once refuses unsafe execution."
    };
  }

  return {
    decision:
      "PROTECT",

    code:
      "CONSEQUENTIAL_HTTP_WRITE",

    consequential:
      true,

    method,

    reason:
      "Consequential HTTP operation has a provider and stable identity and must execute through Once."
  };
}
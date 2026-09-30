import {
  transformHttpWriteV1
} from "./http-write-v1.js";

import {
  validateHttpResponseReplayCapabilityV2
} from "./http-response-capability-v2.js";

export const HTTP_RESPONSE_RETURN_TRANSFORMER_ID =
  "ts_fetch_response_return_v1" as const;

export type HttpResponseReturnTransformInput = {
  statement: string;
  functionSource: string;
  provider: string;
  capability?: unknown;
};

export type HttpResponseReturnTransformSuccess = {
  eligible: true;
  transformer:
    typeof HTTP_RESPONSE_RETURN_TRANSFORMER_ID;
  replacement: string;
  helper:
    "executeHttpWriteResponse";
  actionType:
    "http_write_v1";
  method:
    "POST";
  url: string;
  bodyExpression: string;
  capabilityFingerprint: string;
  requiresResponseBinding: true;
};

export type HttpResponseReturnTransformFailure = {
  eligible: false;
  reason: string;
};

export type HttpResponseReturnTransformResult =
  | HttpResponseReturnTransformSuccess
  | HttpResponseReturnTransformFailure;

function normalize(
  value: string
): string {
  return value
    .replace(/\r\n/g, "\n")
    .trim();
}

export function transformHttpResponseReturnV1(
  input: HttpResponseReturnTransformInput
): HttpResponseReturnTransformResult {
  const statement =
    normalize(input.statement);

  /*
   * Slice 5 proves exactly the frozen returned-response shape:
   *
   *   return await fetch(...);
   *
   * Bare `return fetch(...)`, chained consumers, conditional returns,
   * assignments, and all other response-observation forms remain fail-closed.
   */
  const outerMatch =
    statement.match(
      /^return\s+(await\s+fetch\s*\([\s\S]*\))\s*;?$/
    );

  if (!outerMatch || outerMatch[1] === undefined) {
    return {
      eligible: false,
      reason:
        "Only exact `return await fetch(...)` native Response return is supported."
    };
  }

  const fetchExpression =
    outerMatch[1];

  const requestTransform =
    transformHttpWriteV1({
      statement:
        `${fetchExpression};`,
      functionSource:
        input.functionSource,
      provider:
        input.provider
    });

  if (!requestTransform.eligible) {
    return {
      eligible: false,
      reason:
        requestTransform.reason
    };
  }

  if (
    requestTransform.method !==
      "POST"
  ) {
    return {
      eligible: false,
      reason:
        "Native Response-preserving HTTP protection currently supports POST only."
    };
  }

  if (
    /\bheaders_json\s*:/.test(
      requestTransform.replacement
    )
  ) {
    return {
      eligible: false,
      reason:
        "Native Response-preserving HTTP protection does not yet support preserved target headers."
    };
  }

  const capability =
    validateHttpResponseReplayCapabilityV2({
      provider:
        input.provider,
      targetUrl:
        requestTransform.url,
      capability:
        input.capability
    });

  if (!capability.eligible) {
    return {
      eligible: false,
      reason:
        capability.reason
    };
  }

  const helperCall =
    requestTransform.replacement
      .replace(
        /^await\s+once\.execute\s*\(/,
        "await executeHttpWriteResponse("
      )
      .replace(/;\s*$/, "");

  if (
    !/^await\s+executeHttpWriteResponse\s*\(/.test(
      helperCall
    )
  ) {
    return {
      eligible: false,
      reason:
        "Could not bind the proven HTTP action to the native Response replay helper."
    };
  }

  return {
    eligible: true,
    transformer:
      HTTP_RESPONSE_RETURN_TRANSFORMER_ID,
    replacement:
      `return ${helperCall};`,
    helper:
      "executeHttpWriteResponse",
    actionType:
      "http_write_v1",
    method:
      "POST",
    url:
      requestTransform.url,
    bodyExpression:
      requestTransform.bodyExpression,
    capabilityFingerprint:
      capability.capabilityFingerprint,
    requiresResponseBinding:
      true
  };
}

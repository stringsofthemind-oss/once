import {
  transformHttpWriteV1
} from "./http-write-v1.js";

import {
  validateHttpResponseReplayCapabilityV2
} from "./http-response-capability-v2.js";

export const HTTP_RESPONSE_ASSIGNMENT_TRANSFORMER_ID =
  "ts_fetch_response_assignment_v1" as const;

export type HttpResponseAssignmentTransformInput = {
  statement: string;
  functionSource: string;
  provider: string;
  capability?: unknown;
};

export type HttpResponseAssignmentTransformSuccess = {
  eligible: true;
  transformer:
    typeof HTTP_RESPONSE_ASSIGNMENT_TRANSFORMER_ID;
  replacement: string;
  helper:
    "executeHttpWriteResponse";
  actionType:
    "http_write_v1";
  method:
    "POST";
  url: string;
  bodyExpression: string;
  responseIdentifier: string;
  capabilityFingerprint: string;
  requiresResponseBinding: true;
};

export type HttpResponseAssignmentTransformFailure = {
  eligible: false;
  reason: string;
};

export type HttpResponseAssignmentTransformResult =
  | HttpResponseAssignmentTransformSuccess
  | HttpResponseAssignmentTransformFailure;

function normalize(
  value: string
): string {
  return value
    .replace(/\r\n/g, "\n")
    .trim();
}

export function transformHttpResponseAssignmentV1(
  input: HttpResponseAssignmentTransformInput
): HttpResponseAssignmentTransformResult {
  const statement =
    normalize(input.statement);

  /*
   * Slice 4 proves exactly one retained native Response shape:
   *
   *   const response = await fetch(...);
   *
   * Returned responses, mutable bindings, member assignments, chained
   * consumers, and all other response-observation shapes remain fail-closed.
   */
  const outerMatch =
    statement.match(
      /^const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(await\s+fetch\s*\([\s\S]*\))\s*;?$/
    );

  if (!outerMatch) {
    return {
      eligible: false,
      reason:
        "Only exact `const response = await fetch(...)` native Response assignment is supported."
    };
  }

  const responseIdentifier =
    outerMatch[1];

  const fetchExpression =
    outerMatch[2];

  if (
    responseIdentifier === undefined ||
    fetchExpression === undefined
  ) {
    return {
      eligible: false,
      reason:
        "Could not isolate the assigned native Response fetch expression."
    };
  }

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
      HTTP_RESPONSE_ASSIGNMENT_TRANSFORMER_ID,
    replacement:
      `const ${responseIdentifier} = ${helperCall};`,
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
    responseIdentifier,
    capabilityFingerprint:
      capability.capabilityFingerprint,
    requiresResponseBinding:
      true
  };
}

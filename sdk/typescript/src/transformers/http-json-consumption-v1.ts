import {
  transformHttpWriteV1
} from "./http-write-v1.js";

import {
  validateHttpResponseReplayCapabilityV1
} from "./http-response-capability-v1.js";

export const HTTP_JSON_CONSUMPTION_TRANSFORMER_ID =
  "ts_fetch_json_consumption_v1" as const;

export type HttpJsonConsumptionTransformInput = {
  statement: string;
  functionSource: string;
  provider: string;
  capability?: unknown;
};

export type HttpJsonConsumptionTransformSuccess = {
  eligible: true;
  transformer:
    typeof HTTP_JSON_CONSUMPTION_TRANSFORMER_ID;
  replacement: string;
  helper:
    "executeHttpWriteJsonResponse";
  actionType:
    "http_write_v1";
  method:
    "POST";
  url: string;
  bodyExpression: string;
  resultIdentifier: string;
  capabilityFingerprint: string;
  requiresResponseBinding: true;
};

export type HttpJsonConsumptionTransformFailure = {
  eligible: false;
  reason: string;
};

export type HttpJsonConsumptionTransformResult =
  | HttpJsonConsumptionTransformSuccess
  | HttpJsonConsumptionTransformFailure;

function normalize(
  value: string
): string {
  return value
    .replace(/\r\n/g, "\n")
    .trim();
}

export function transformHttpJsonConsumptionV1(
  input: HttpJsonConsumptionTransformInput
): HttpJsonConsumptionTransformResult {
  const statement =
    normalize(input.statement);

  /*
   * v1 deliberately proves exactly one response-observation
   * shape:
   *
   *   const result = await (await fetch(...)).json();
   *
   * A returned or retained Response has additional observable
   * native Fetch semantics (for example url/statusText/body
   * stream behavior) that the current replay receipt does not
   * completely encode, so those shapes remain fail-closed.
   */
  const outerMatch =
    statement.match(
      /^const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*await\s*\(\s*(await\s+fetch\s*\([\s\S]*\))\s*\)\.json\(\)\s*;?$/
    );

  if (!outerMatch) {
    return {
      eligible: false,
      reason:
        "Only immediate `const result = await (await fetch(...)).json()` response consumption is supported."
    };
  }

  const resultIdentifier =
    outerMatch[1];

  const fetchStatement =
    `${outerMatch[2]};`;

  if (
    resultIdentifier === undefined ||
    outerMatch[2] === undefined
  ) {
    return {
      eligible: false,
      reason:
        "Could not isolate the response-consuming fetch expression."
    };
  }

  /*
   * Reuse the existing proven request-shape transformer instead
   * of implementing a second URL/method/header/body parser.
   */
  const requestTransform =
    transformHttpWriteV1({
      statement:
        fetchStatement,
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

  /*
   * Response replay execution is currently proven only for the
   * POST response-replay provider contract. Existing unused-
   * response PUT/PATCH/DELETE support remains unchanged.
   */
  if (
    requestTransform.method !==
      "POST"
  ) {
    return {
      eligible: false,
      reason:
        "Response-preserving HTTP protection currently supports POST only."
    };
  }

  /*
   * The current response-replay contract does not prove arbitrary
   * preserved target headers. Exact static Content-Type is erased
   * by the existing transformer because body_json already defines
   * JSON semantics; any surviving headers_json means a richer
   * request shape and remains fail-closed here.
   */
  if (
    /\bheaders_json\s*:/.test(
      requestTransform.replacement
    )
  ) {
    return {
      eligible: false,
      reason:
        "Response-preserving HTTP protection does not yet support preserved target headers."
    };
  }

  const capability =
    validateHttpResponseReplayCapabilityV1({
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
        "await executeHttpWriteJsonResponse("
      )
      .replace(/;\s*$/, "");

  if (
    !/^await\s+executeHttpWriteJsonResponse\s*\(/.test(
      helperCall
    )
  ) {
    return {
      eligible: false,
      reason:
        "Could not bind the proven HTTP action to the JSON replay helper."
    };
  }

  const replacement =
    `const ${resultIdentifier} = ${helperCall};`;

  return {
    eligible: true,
    transformer:
      HTTP_JSON_CONSUMPTION_TRANSFORMER_ID,
    replacement,
    helper:
      "executeHttpWriteJsonResponse",
    actionType:
      "http_write_v1",
    method:
      "POST",
    url:
      requestTransform.url,
    bodyExpression:
      requestTransform.bodyExpression,
    resultIdentifier,
    capabilityFingerprint:
      capability.capabilityFingerprint,
    requiresResponseBinding:
      true
  };
}

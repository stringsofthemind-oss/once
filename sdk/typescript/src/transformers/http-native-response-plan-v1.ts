import {
  buildHttpResponsePatchV1
} from "./http-response-patch-plan-v1.js";

import {
  buildHttpResponseReturnPatchV1
} from "./http-response-return-patch-plan-v1.js";

import {
  extractHttpNativeResponseStatementV1
} from "./http-response-source-v1.js";

export type HttpNativeResponsePlanInput = {
  source: string;
  awaitFetchStatement: string;
  awaitFetchStartOffset: number;
  functionSource: string;
  provider: string;
  capability?: unknown;
};

export type HttpNativeResponsePlanNotMatched = {
  matched: false;
};

export type HttpNativeResponsePlanFailure = {
  matched: true;
  eligible: false;
  kind: "assignment" | "return";
  reason: string;
};

export type HttpNativeResponsePlanSuccess = {
  matched: true;
  eligible: true;
  kind: "assignment" | "return";
  transformerId:
    | "ts_fetch_response_assignment_v1"
    | "ts_fetch_response_return_v1";
  patchPlan:
    | "ts_fetch_response_assignment_patch_v1"
    | "ts_fetch_response_return_patch_v1";
  bindingStrategy:
    "http-response-helper-import";
  proposedSource: string;
  targetUrl: string;
  sourceSha256: string;
  proposedSourceSha256: string;
  capabilityFingerprint: string;
};

export type HttpNativeResponsePlanResult =
  | HttpNativeResponsePlanNotMatched
  | HttpNativeResponsePlanFailure
  | HttpNativeResponsePlanSuccess;

export function buildHttpNativeResponsePlanV1(
  input: HttpNativeResponsePlanInput
): HttpNativeResponsePlanResult {
  const extracted =
    extractHttpNativeResponseStatementV1(
      input.source,
      input.awaitFetchStartOffset,
      input.awaitFetchStatement
    );

  if (!extracted) {
    return {
      matched: false
    };
  }

  const patch =
    extracted.kind === "assignment"
      ? buildHttpResponsePatchV1({
          source:
            input.source,
          statement:
            extracted.statement,
          functionSource:
            input.functionSource,
          provider:
            input.provider,
          capability:
            input.capability
        })
      : buildHttpResponseReturnPatchV1({
          source:
            input.source,
          statement:
            extracted.statement,
          functionSource:
            input.functionSource,
          provider:
            input.provider,
          capability:
            input.capability
        });

  if (!patch.eligible) {
    return {
      matched: true,
      eligible: false,
      kind:
        extracted.kind,
      reason:
        patch.reason
    };
  }

  return {
    matched: true,
    eligible: true,
    kind:
      extracted.kind,
    transformerId:
      patch.transformerId,
    patchPlan:
      patch.patchPlan,
    bindingStrategy:
      patch.bindingStrategy,
    proposedSource:
      patch.proposedSource,
    targetUrl:
      patch.targetUrl,
    sourceSha256:
      patch.sourceSha256,
    proposedSourceSha256:
      patch.proposedSourceSha256,
    capabilityFingerprint:
      patch.capabilityFingerprint
  };
}

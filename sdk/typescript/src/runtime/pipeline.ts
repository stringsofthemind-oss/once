import {
  decideHttpExecution,
  type OnceRuntimeDecision,
  type OnceRuntimeDecisionCode
} from "./decision.js";

import {
  resolveHttpOperationIdentity,
  type RuntimeIdentitySource,
  type RuntimeIdentityResult
} from "./identity.js";

type RuntimeIdentityStatus =
  RuntimeIdentityResult["status"];

export type OnceRuntimePipelineCode =
  | OnceRuntimeDecisionCode
  | "IDENTITY_REQUIRED"
  | "IDENTITY_CONFLICT";

export type OnceRuntimeHttpRequest = {
  method: string;
  url: string;
  provider?: string;
  operationId?: string;

  headers?: Record<
    string,
    string | string[] | undefined
  >;

  body?: unknown;
};

export type OnceRuntimePipelineResult = {
  decision: OnceRuntimeDecision;
  code: OnceRuntimePipelineCode;
  consequential: boolean;
  method: string;
  reason: string;

  operationId?: string;
  identitySource?: RuntimeIdentitySource;
  identityStatus: RuntimeIdentityStatus;
};

export function prepareHttpExecution(
  request: OnceRuntimeHttpRequest
): OnceRuntimePipelineResult {

  const identity =
    resolveHttpOperationIdentity({
      method:
        request.method,

      url:
        request.url,

      operationId:
        request.operationId,

      headers:
        request.headers,

      body:
        request.body
    });

  const resolvedOperationId =
    identity.status === "FOUND"
      ? identity.operationId
      : undefined;

  const gate =
    decideHttpExecution({
      surface:
        "http",

      method:
        request.method,

      url:
        request.url,

      provider:
        request.provider,

      operationId:
        resolvedOperationId
    });

  /*
   * Safe reads pass normally and do not require
   * stable operation identity.
   */
  if (
    gate.decision === "PASS"
  ) {

    return {
      decision:
        gate.decision,

      code:
        gate.code,

      consequential:
        gate.consequential,

      method:
        gate.method,

      reason:
        gate.reason,

      identityStatus:
        identity.status
    };
  }

  /*
   * Structural failures take precedence.
   */
  if (
    gate.code === "INVALID_URL" ||
    gate.code === "UNSUPPORTED_PROTOCOL" ||
    gate.code === "UNSUPPORTED_HTTP_METHOD"
  ) {

    return {
      decision:
        gate.decision,

      code:
        gate.code,

      consequential:
        gate.consequential,

      method:
        gate.method,

      reason:
        gate.reason,

      identityStatus:
        identity.status
    };
  }

  /*
   * Never choose between conflicting identities.
   */
  if (
    identity.status === "CONFLICT"
  ) {

    return {
      decision:
        "BLOCK",

      code:
        "IDENTITY_CONFLICT",

      consequential:
        true,

      method:
        gate.method,

      reason:
        identity.reason,

      identityStatus:
        identity.status
    };
  }

  /*
   * Provider is required for protected execution.
   */
  if (
    gate.code === "MISSING_PROVIDER"
  ) {

    return {
      decision:
        "BLOCK",

      code:
        "MISSING_PROVIDER",

      consequential:
        true,

      method:
        gate.method,

      reason:
        gate.reason,

      identityStatus:
        identity.status,

      ...(
        identity.status === "FOUND"
          ? {
              operationId:
                identity.operationId,

              identitySource:
                identity.source
            }
          : {}
      )
    };
  }

  /*
   * Consequential writes without trustworthy
   * stable identity fail closed.
   */
  if (
    identity.status === "REQUIRED"
  ) {

    return {
      decision:
        "BLOCK",

      code:
        "IDENTITY_REQUIRED",

      consequential:
        true,

      method:
        gate.method,

      reason:
        identity.reason,

      identityStatus:
        identity.status
    };
  }

  /*
   * FOUND identity + provider must result in
   * protected execution.
   */
  if (
    gate.decision !== "PROTECT"
  ) {

    return {
      decision:
        "BLOCK",

      code:
        gate.code,

      consequential:
        true,

      method:
        gate.method,

      reason:
        "Runtime reached an unexpected execution state and failed closed.",

      identityStatus:
        identity.status
    };
  }

  return {
    decision:
      "PROTECT",

    code:
      gate.code,

    consequential:
      true,

    method:
      gate.method,

    reason:
      gate.reason,

    operationId:
      identity.operationId,

    identitySource:
      identity.source,

    identityStatus:
      identity.status
  };
}
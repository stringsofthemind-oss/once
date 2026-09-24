import {
  CONNECT_DECISION,
  classifyConnectOperation,
} from "./classifier.js";

import type {
  ConnectClassification,
  ConnectSafetyDeclaration,
} from "./classifier.js";

import {
  bindConnectOperation,
} from "./binding.js";

import type {
  ConnectPayload,
} from "./binding.js";

export interface ConnectProtectedContext {
  operationId: string;
  payload: ConnectPayload;
  payloadFingerprint: string;
  classification: Readonly<ConnectClassification>;
}

export interface ConnectExecutionInput<T = unknown> {
  safety: ConnectSafetyDeclaration;
  operationId: string;
  payload: ConnectPayload;
  bypass?: () => Promise<T> | T;
  protect?: (
    context: ConnectProtectedContext,
  ) => Promise<T> | T;
}

export class ConnectExecutionError extends Error {
  readonly code: string;

  constructor(
    message: string,
    code: string,
  ) {
    super(message);
    this.name = "ConnectExecutionError";
    this.code = code;
  }
}

/**
 * Framework-neutral Connect orchestration boundary.
 *
 * Connect decides whether the proposed tool call requires
 * Once protection. It does not implement execution safety.
 *
 * Protected execution is delegated to the existing Once
 * runtime/kernel supplied by the caller.
 */
export async function executeConnectOperation<T = unknown>({
  safety,
  operationId,
  payload,
  bypass,
  protect,
}: ConnectExecutionInput<T>): Promise<T> {
  const classification =
    classifyConnectOperation(safety);

  if (
    classification.decision ===
    CONNECT_DECISION.REJECT
  ) {
    throw new ConnectExecutionError(
      "Once Connect rejected an incomplete or invalid safety declaration.",
      "CONNECT_REJECTED",
    );
  }

  if (
    classification.decision ===
    CONNECT_DECISION.BYPASS
  ) {
    if (typeof bypass !== "function") {
      throw new ConnectExecutionError(
        "Once Connect bypass execution is unavailable.",
        "BYPASS_HANDLER_MISSING",
      );
    }

    return await bypass();
  }

  const binding =
    bindConnectOperation({
      operationId,
      payload,
    });

  if (typeof protect !== "function") {
    throw new ConnectExecutionError(
      "Once Connect protected execution is unavailable.",
      "PROTECT_HANDLER_MISSING",
    );
  }

  return await protect({
    operationId:
      binding.operationId,

    payload,

    payloadFingerprint:
      binding.payloadFingerprint,

    classification,
  });
}

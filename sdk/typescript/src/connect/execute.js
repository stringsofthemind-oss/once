import {
  CONNECT_DECISION,
  classifyConnectOperation,
} from "./classifier.js";

import {
  bindConnectOperation,
} from "./binding.js";

export class ConnectExecutionError extends Error {
  constructor(message, code) {
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
export async function executeConnectOperation({
  safety,
  operationId,
  payload,
  bypass,
  protect,
}) {
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

  /*
   * Binding is intentionally performed before handing
   * control to the existing Once execution kernel.
   *
   * This proves that protected work has both stable
   * logical identity and a consequential-payload
   * fingerprint before execution can begin.
   */
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

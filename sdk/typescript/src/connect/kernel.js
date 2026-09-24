import {
  executeConnectOperation,
  ConnectExecutionError,
} from "./execute.js";

export class ConnectKernelError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ConnectKernelError";
    this.code = code;
  }
}

/**
 * Route a proposed tool operation through Connect and, when protection
 * is required, through the existing authoritative Once.execute() kernel.
 *
 * This adapter deliberately contains no execution-state machine,
 * replay logic, reconciliation logic, or truth semantics.
 */
export async function executeConnectWithOnce({
  once,
  provider,
  safety,
  operationId,
  payload,
  action,
  bypass,
}) {
  if (
    !once ||
    typeof once.execute !== "function"
  ) {
    throw new ConnectKernelError(
      "Once Connect requires an existing Once client.",
      "ONCE_CLIENT_REQUIRED",
    );
  }

  return executeConnectOperation({
    safety,
    operationId,
    payload,

    bypass,

    protect: async (context) => {
      if (
        typeof provider !== "string" ||
        provider.trim() === ""
      ) {
        throw new ConnectKernelError(
          "Protected Connect execution requires a Once provider.",
          "PROVIDER_REQUIRED",
        );
      }

      if (
        action === null ||
        typeof action !== "object" ||
        Array.isArray(action)
      ) {
        throw new ConnectKernelError(
          "Protected Connect execution requires an action object.",
          "ACTION_REQUIRED",
        );
      }

      return once.execute({
        operationId: context.operationId,
        provider,
        action,
      });
    },
  });
}

export {
  ConnectExecutionError,
};

import {
  executeConnectWithOnce,
} from "./kernel.js";

import type {
  ConnectSafetyDeclaration,
} from "./classifier.js";

import type {
  Once,
} from "../index.js";

export type OpenAIAgentsToolInput =
  Record<string, unknown>;

export type OpenAIAgentsAction =
  Record<string, unknown>;

export interface OpenAIAgentsConnectToolInput {
  once: Once;
  provider: string;
  safety: ConnectSafetyDeclaration;
  operationId: string;
  input: OpenAIAgentsToolInput;
  action: OpenAIAgentsAction;
  bypass?: () => unknown | Promise<unknown>;
}

export class OpenAIAgentsConnectError extends Error {
  readonly code: string;

  constructor(
    message: string,
    code: string,
  ) {
    super(message);
    this.name = "OpenAIAgentsConnectError";
    this.code = code;
  }
}

/**
 * Minimal OpenAI Agents -> Once Connect execution adapter.
 *
 * This adapter owns no execution-safety state machine.
 * It validates the framework boundary and delegates to
 * the existing Connect -> Once kernel.
 *
 * OpenAI tool-call IDs are intentionally not used as
 * logical operation identity. The caller must provide a
 * stable operationId representing the same real-world
 * logical operation across retries.
 */
export async function executeOpenAIAgentsConnectTool(
  {
    once,
    provider,
    safety,
    operationId,
    input,
    action,
    bypass,
  }: OpenAIAgentsConnectToolInput,
): Promise<unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new OpenAIAgentsConnectError(
      "Once Connect requires parsed OpenAI Agents tool input.",
      "INVALID_OPENAI_TOOL_INPUT",
    );
  }

  return await executeConnectWithOnce({
    once,
    provider,
    safety,
    operationId,

    /*
     * Parsed consequential tool input becomes the payload
     * bound to the stable logical operation identity.
     */
    payload: input,

    action,
    bypass,
  });
}

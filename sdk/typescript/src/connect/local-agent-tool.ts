import {
  CONNECT_DECISION,
  classifyConnectOperation,
  type ConnectSafetyDeclaration,
} from "./classifier.js";
import {
  CONNECT_TOOL_DECISION,
  classifyConnectTool,
  type ConnectToolDescriptor,
} from "./tool-classifier.js";
import {
  protectLocal,
  type LocalObservation,
} from "../local.js";

type EffectPayload = Record<string, unknown>;

export interface AgentTool<Input, Result> {
  execute(input: Input): Promise<Result>;
}

export interface LocalAgentToolContract<Input, Result> {
  /** Unique, stable name for this registered tool. Changing it changes identity. */
  name: string;
  /** Reviewed declaration about this tool's actual external effect. */
  safety: ConnectSafetyDeclaration;
  /** One intentional action ID, reused for retries. Required when protected. */
  id?: (input: Input) => string;
  /** Every input that can change the external effect. Required when protected. */
  payload?: (input: Input) => EffectPayload;
  /** Durable same-machine SQLite file, shared by all callers of this tool. */
  statePath?: string;
  /** Read-only, authoritative provider lookup for an uncertain outcome. */
  reconcile?: (context: {
    id: string;
    payload: EffectPayload;
  }) => Promise<LocalObservation<Result>> | LocalObservation<Result>;
}

export interface AutoLocalAgentToolContract<Input, Result> {
  /** Tool metadata used by Once Connect to infer PROTECT/BYPASS/UNKNOWN. */
  descriptor: ConnectToolDescriptor;
  /** One intentional action ID, reused for retries. Required when inferred protected. */
  id?: (input: Input) => string;
  /** Every input that can change the external effect. Required when inferred protected. */
  payload?: (input: Input) => EffectPayload;
  /** Durable same-machine SQLite file, shared by all callers of this tool. */
  statePath?: string;
  /** Read-only, authoritative provider lookup for an uncertain outcome. */
  reconcile?: (context: {
    id: string;
    payload: EffectPayload;
  }) => Promise<LocalObservation<Result>> | LocalObservation<Result>;
}

export class AgentToolConnectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentToolConnectionError";
  }
}

/**
 * Connect one registered agent tool to Once. The agent calls execute normally;
 * classification happens for every invocation without a model-side Once call.
 *
 * The tool owner must review the safety declaration, identity and effect
 * payload. This same-machine path never auto-discovers arbitrary tools and
 * cannot coordinate hosts with separate SQLite files. Supply only the
 * returned tool to the agent; an exposed original tool remains a bypass.
 */
export function connectLocalAgentTool<Input, Result>(
  tool: AgentTool<Input, Result>,
  contract: LocalAgentToolContract<Input, Result>,
): AgentTool<Input, Result> {
  if (!tool || typeof tool.execute !== "function") {
    throw new AgentToolConnectionError(
      "INVALID_TOOL",
      "Once needs a tool with an execute(input) function.",
    );
  }

  if (
    !contract ||
    typeof contract.name !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(contract.name)
  ) {
    throw new AgentToolConnectionError(
      "INVALID_TOOL_NAME",
      "A stable registered tool name is required.",
    );
  }

  const classification = classifyConnectOperation(contract.safety);
  if (classification.decision === CONNECT_DECISION.REJECT) {
    throw new AgentToolConnectionError(
      "INVALID_SAFETY_DECLARATION",
      "Review all four safety conditions before connecting an agent tool.",
    );
  }

  if (classification.decision === CONNECT_DECISION.BYPASS) {
    return {
      execute: (input) => tool.execute.call(tool, input),
    };
  }

  if (typeof contract.id !== "function" || typeof contract.payload !== "function") {
    throw new AgentToolConnectionError(
      "PROTECTION_REQUIRED",
      "A consequential tool requires stable intent identity and complete effect payload before it can be connected.",
    );
  }

  const id = contract.id;
  const payload = contract.payload;
  const name = contract.name;

  const protectedExecute = protectLocal(
    async (input: Input) => tool.execute.call(tool, input),
    {
      id: (input) => {
        const intent = id(input);
        return typeof intent === "string" && intent.trim() !== ""
          ? `${name}:${intent}`
          : "";
      },
      payload: (input) => ({ tool: name, effect: payload(input) }),
      statePath: contract.statePath,
      reconcile: contract.reconcile,
    },
  );

  return {
    execute: (input) => protectedExecute(input),
  };
}

const AUTO_PROTECTED_SAFETY: ConnectSafetyDeclaration = Object.freeze({
  changesExternalState: true,
  retryPossible: true,
  ambiguousOutcomePossible: true,
  duplicateUndesirable: true,
});

const AUTO_BYPASS_SAFETY: ConnectSafetyDeclaration = Object.freeze({
  changesExternalState: false,
  retryPossible: false,
  ambiguousOutcomePossible: false,
  duplicateUndesirable: false,
});

/**
 * Connect a local agent tool using its descriptor instead of a hand-authored
 * four-boolean safety declaration.
 *
 * Automatic routing is intentionally conservative:
 * - PROTECT -> delegate to the existing protected local connector;
 * - BYPASS -> delegate to the existing bypass path;
 * - UNKNOWN -> refuse connection until the tool is clarified.
 *
 * Inferred protection does not weaken operation identity requirements. A
 * protected tool still needs a stable intent ID and complete effect payload.
 */
export function connectLocalAgentToolAuto<Input, Result>(
  tool: AgentTool<Input, Result>,
  contract: AutoLocalAgentToolContract<Input, Result>,
): AgentTool<Input, Result> {
  if (!contract || !contract.descriptor) {
    throw new AgentToolConnectionError(
      "UNKNOWN_TOOL_SAFETY",
      "Once Connect needs a tool descriptor before automatic routing can be established.",
    );
  }

  const classification = classifyConnectTool(contract.descriptor);

  if (classification.decision === CONNECT_TOOL_DECISION.UNKNOWN) {
    throw new AgentToolConnectionError(
      "UNKNOWN_TOOL_SAFETY",
      `Once Connect cannot safely auto-route ${contract.descriptor.name || "this tool"}: ${classification.reason}.`,
    );
  }

  return connectLocalAgentTool(tool, {
    name: contract.descriptor.name,
    safety:
      classification.decision === CONNECT_TOOL_DECISION.PROTECT
        ? AUTO_PROTECTED_SAFETY
        : AUTO_BYPASS_SAFETY,
    id: contract.id,
    payload: contract.payload,
    statePath: contract.statePath,
    reconcile: contract.reconcile,
  });
}

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
  resolveConnectToolOperationIdentity,
} from "./identity.js";
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
  /** Optional explicit stable intent identity. When omitted, Once may resolve a trustworthy identity carrier from input. */
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
 * For protected tools, effect payload selection remains explicit. Stable
 * operation identity may be supplied by `id()` or resolved at execution time
 * from trustworthy operation/idempotency/intent carriers in the tool input.
 * Missing or conflicting automatic identity fails before the side effect.
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

  if (classification.decision === CONNECT_TOOL_DECISION.BYPASS) {
    return connectLocalAgentTool(tool, {
      name: contract.descriptor.name,
      safety: AUTO_BYPASS_SAFETY,
      statePath: contract.statePath,
    });
  }

  const identity = typeof contract.id === "function"
    ? contract.id
    : (input: Input): string => {
        const result = resolveConnectToolOperationIdentity({
          tool: contract.descriptor,
          input,
        });

        if (result.status === "FOUND") {
          return result.operationId;
        }

        if (result.status === "CONFLICT") {
          throw new AgentToolConnectionError(
            "IDENTITY_CONFLICT",
            result.reason,
          );
        }

        throw new AgentToolConnectionError(
          "IDENTITY_REQUIRED",
          result.reason,
        );
      };

  return connectLocalAgentTool(tool, {
    name: contract.descriptor.name,
    safety: AUTO_PROTECTED_SAFETY,
    id: identity,
    payload: contract.payload,
    statePath: contract.statePath,
    reconcile: contract.reconcile,
  });
}

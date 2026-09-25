import {
  CONNECT_DECISION,
  classifyConnectOperation,
  type ConnectSafetyDeclaration,
} from "./classifier.js";
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

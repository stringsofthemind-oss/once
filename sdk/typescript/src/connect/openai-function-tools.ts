import {
  CONNECT_TOOL_DECISION,
  type ConnectToolAnnotations,
  type ConnectToolDescriptor,
} from "./tool-classifier.js";
import {
  resolveConnectToolOperationIdentity,
} from "./identity.js";
import {
  resolveConnectToolEffectPayload,
} from "./payload.js";
import {
  connectLocalAgentToolsetAuto,
  type AutoLocalAgentToolsetOverride,
  type LocalAgentToolRegistry,
} from "./toolset.js";
import {
  AgentToolConnectionError,
} from "./local-agent-tool.js";
import {
  OpenAIAgentsConnectError,
} from "./openai-agents.js";
import type {
  ConnectManifestPlan,
} from "./manifest.js";
import type {
  LocalObservation,
} from "../local.js";

export {
  OpenAIAgentsConnectError,
} from "./openai-agents.js";

export type OpenAIAgentsParsedToolInput =
  Record<string, unknown>;

/**
 * Structural subset of the current @openai/agents FunctionTool contract.
 *
 * Once intentionally does not depend on @openai/agents at runtime. Keeping the
 * adapter structural avoids forcing an Agents SDK version onto applications
 * that already own that dependency.
 */
export interface OpenAIAgentsFunctionToolLike {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
  invoke(
    runContext: unknown,
    input: string,
    details?: unknown,
  ): Promise<unknown>;
  [key: string]: unknown;
}

export interface OpenAIAgentsFunctionToolOverride {
  /** Optional explicit Connect safety annotations for ambiguous tool names/descriptions. */
  annotations?: ConnectToolAnnotations;
  /** Optional Once metadata such as identityFields/effectFields. */
  _meta?: Record<string, unknown>;
  /** Optional explicit stable identity selector over parsed tool arguments. */
  id?: (input: OpenAIAgentsParsedToolInput) => string;
  /** Optional explicit consequential payload selector over parsed tool arguments. */
  payload?: (
    input: OpenAIAgentsParsedToolInput,
  ) => Record<string, unknown>;
  /** Optional per-tool state path override. */
  statePath?: string;
  /** Optional provider reconciliation hook. */
  reconcile?: (context: {
    id: string;
    payload: Record<string, unknown>;
  }) =>
    | Promise<LocalObservation<unknown>>
    | LocalObservation<unknown>;
}

export interface ConnectOpenAIAgentsFunctionToolsOptions {
  /** Shared default SQLite state path for protected local function tools. */
  statePath?: string;
  /** Optional per-tool metadata and escape hatches. */
  overrides?: Readonly<
    Record<
      string,
      OpenAIAgentsFunctionToolOverride | undefined
    >
  >;
}

export interface ConnectedOpenAIAgentsFunctionTools<
  T extends readonly OpenAIAgentsFunctionToolLike[],
> {
  /** The exact Connect protection plan used to wrap the tools. */
  plan: Readonly<ConnectManifestPlan>;
  /** New FunctionTool objects. The input array and originals are not mutated. */
  tools: Readonly<{
    [K in keyof T]: T[K]
  }>;
}

interface OpenAIInvocationEnvelope {
  runContext: unknown;
  rawInput: string;
  details?: unknown;
  parsedInput?: OpenAIAgentsParsedToolInput;
}

function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function isFunctionToolLike(
  value: unknown,
): value is OpenAIAgentsFunctionToolLike {
  return isObject(value) &&
    value.type === "function" &&
    typeof value.name === "string" &&
    value.name.trim() !== "" &&
    typeof value.description === "string" &&
    Object.prototype.hasOwnProperty.call(value, "parameters") &&
    typeof value.invoke === "function";
}

function parseProtectedInput(
  toolName: string,
  rawInput: unknown,
): OpenAIAgentsParsedToolInput {
  if (typeof rawInput !== "string") {
    throw new OpenAIAgentsConnectError(
      `Once Connect expected OpenAI Agents function tool "${toolName}" to receive JSON text input.`,
      "INVALID_OPENAI_TOOL_INPUT",
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawInput);
  } catch {
    throw new OpenAIAgentsConnectError(
      `Once Connect could not parse protected OpenAI Agents tool input for "${toolName}".`,
      "INVALID_OPENAI_TOOL_INPUT",
    );
  }

  if (!isObject(parsed)) {
    throw new OpenAIAgentsConnectError(
      `Once Connect requires protected OpenAI Agents tool input for "${toolName}" to be a JSON object.`,
      "INVALID_OPENAI_TOOL_INPUT",
    );
  }

  return parsed;
}

function requireParsedInput(
  toolName: string,
  envelope: OpenAIInvocationEnvelope,
): OpenAIAgentsParsedToolInput {
  if (!envelope.parsedInput) {
    throw new OpenAIAgentsConnectError(
      `Once Connect did not receive parsed protected input for "${toolName}".`,
      "INVALID_OPENAI_TOOL_INPUT",
    );
  }

  return envelope.parsedInput;
}

function descriptorFor(
  tool: OpenAIAgentsFunctionToolLike,
  override: OpenAIAgentsFunctionToolOverride | undefined,
): ConnectToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    ...(override?.annotations !== undefined
      ? { annotations: override.annotations }
      : {}),
    ...(override?._meta !== undefined
      ? { _meta: override._meta }
      : {}),
  };
}

function resolveIdentityForEnvelope(
  descriptor: ConnectToolDescriptor,
  envelope: OpenAIInvocationEnvelope,
  override: OpenAIAgentsFunctionToolOverride | undefined,
): string {
  const input = requireParsedInput(descriptor.name, envelope);

  if (typeof override?.id === "function") {
    return override.id(input);
  }

  const result = resolveConnectToolOperationIdentity({
    tool: descriptor,
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
}

function resolvePayloadForEnvelope(
  descriptor: ConnectToolDescriptor,
  envelope: OpenAIInvocationEnvelope,
  override: OpenAIAgentsFunctionToolOverride | undefined,
): Record<string, unknown> {
  const input = requireParsedInput(descriptor.name, envelope);

  if (typeof override?.payload === "function") {
    return override.payload(input);
  }

  const result = resolveConnectToolEffectPayload({
    tool: descriptor,
    input,
  });

  if (result.status === "FOUND") {
    return { ...result.payload };
  }

  throw new AgentToolConnectionError(
    "PAYLOAD_REQUIRED",
    result.reason,
  );
}

function cloneFunctionToolWithInvoke<
  T extends OpenAIAgentsFunctionToolLike,
>(
  tool: T,
  invoke: T["invoke"],
): T {
  const descriptors = Object.getOwnPropertyDescriptors(tool);
  const originalInvoke = Object.getOwnPropertyDescriptor(
    tool,
    "invoke",
  );

  Reflect.deleteProperty(descriptors, "invoke");

  const clone = Object.create(
    Object.getPrototypeOf(tool),
    descriptors,
  ) as T;

  Object.defineProperty(clone, "invoke", {
    value: invoke,
    enumerable: originalInvoke?.enumerable ?? true,
    configurable: originalInvoke?.configurable ?? true,
    writable: originalInvoke?.writable ?? true,
  });

  return clone;
}

/**
 * Connect a complete array of OpenAI Agents SDK FunctionTool objects to Once.
 *
 * The returned FunctionTools preserve the original framework object shape and
 * replace only `invoke`. Tool-call IDs/details are never used as logical Once
 * identity. Protected calls derive identity/effect from the parsed JSON tool
 * arguments and execute the original `invoke` with the original raw input,
 * run context and call details.
 *
 * This v1 adapter is deliberately FunctionTool-only. Passing hosted, shell,
 * computer, apply-patch, MCP or other tool types fails closed rather than
 * returning a partially protected agent tool list.
 */
export function connectOpenAIAgentsFunctionToolsAuto<
  T extends readonly OpenAIAgentsFunctionToolLike[],
>(
  tools: T,
  options: ConnectOpenAIAgentsFunctionToolsOptions = {},
): Readonly<ConnectedOpenAIAgentsFunctionTools<T>> {
  if (!Array.isArray(tools)) {
    throw new OpenAIAgentsConnectError(
      "Once Connect needs an array of OpenAI Agents FunctionTool objects.",
      "INVALID_OPENAI_TOOLSET",
    );
  }

  const registry = Object.create(null) as LocalAgentToolRegistry;
  const manifest: ConnectToolDescriptor[] = [];
  const internalOverrides = Object.create(null) as Record<
    string,
    AutoLocalAgentToolsetOverride | undefined
  >;
  const originals = new Map<string, OpenAIAgentsFunctionToolLike>();

  for (const candidate of tools) {
    if (!isFunctionToolLike(candidate)) {
      throw new OpenAIAgentsConnectError(
        "Once Connect v1 supports only OpenAI Agents FunctionTool objects with name, description, parameters and invoke.",
        "UNSUPPORTED_OPENAI_TOOL_TYPE",
      );
    }

    const override = options.overrides?.[candidate.name];
    const descriptor = descriptorFor(candidate, override);

    manifest.push(descriptor);
    originals.set(candidate.name, candidate);

    registry[candidate.name] = {
      execute: async (envelope: OpenAIInvocationEnvelope) =>
        await candidate.invoke(
          envelope.runContext,
          envelope.rawInput,
          envelope.details,
        ),
    };

    internalOverrides[candidate.name] = {
      statePath: override?.statePath ?? options.statePath,
      id: (envelope: OpenAIInvocationEnvelope) =>
        resolveIdentityForEnvelope(
          descriptor,
          envelope,
          override,
        ),
      payload: (envelope: OpenAIInvocationEnvelope) =>
        resolvePayloadForEnvelope(
          descriptor,
          envelope,
          override,
        ),
      reconcile: override?.reconcile,
    };
  }

  if (options.overrides) {
    for (const name of Object.keys(options.overrides)) {
      if (!originals.has(name)) {
        internalOverrides[name] = {};
      }
    }
  }

  const connected = connectLocalAgentToolsetAuto(
    registry,
    {
      manifest,
      statePath: options.statePath,
      overrides: internalOverrides,
    },
  );

  const decisions = new Map(
    connected.plan.entries.map(entry => [
      entry.name,
      entry.decision,
    ]),
  );

  const wrappedTools = tools.map((tool) => {
    const decision = decisions.get(tool.name);
    const connectedTool = connected.tools[tool.name];

    if (!connectedTool) {
      throw new OpenAIAgentsConnectError(
        `Once Connect did not produce a connected implementation for "${tool.name}".`,
        "INVALID_OPENAI_TOOLSET",
      );
    }

    const wrappedInvoke = async (
      runContext: unknown,
      rawInput: string,
      details?: unknown,
    ): Promise<unknown> => {
      const envelope: OpenAIInvocationEnvelope = {
        runContext,
        rawInput,
        details,
        ...(decision === CONNECT_TOOL_DECISION.PROTECT
          ? {
              parsedInput: parseProtectedInput(
                tool.name,
                rawInput,
              ),
            }
          : {}),
      };

      return await connectedTool.execute(envelope);
    };

    return cloneFunctionToolWithInvoke(
      tool,
      wrappedInvoke as typeof tool.invoke,
    );
  }) as unknown as {
    [K in keyof T]: T[K]
  };

  return Object.freeze({
    plan: connected.plan,
    tools: Object.freeze(wrappedTools),
  });
}

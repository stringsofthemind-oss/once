import {
  protectLocal,
  type LocalObservation,
} from "../local.js";
import {
  resolveConnectToolOperationIdentity,
} from "./identity.js";
import {
  resolveConnectToolEffectPayload,
} from "./payload.js";
import {
  CONNECT_TOOL_DECISION,
  classifyConnectTool,
  type ConnectToolDecision,
  type ConnectToolDescriptor,
} from "./tool-classifier.js";

export type McpToolArguments = Record<string, unknown>;

export interface McpToolCallRequest {
  name: string;
  arguments?: McpToolArguments;
  /** Transport correlation only. Never participates in logical-operation identity. */
  requestId?: unknown;
}

export interface McpUpstreamClient<Result = unknown> {
  callTool(request: Readonly<{
    name: string;
    arguments: McpToolArguments;
    requestId?: unknown;
  }>): Promise<Result>;
}

export type McpBoundaryDecision = ConnectToolDecision;

export interface McpBoundaryPlanEntry {
  name: string;
  decision: McpBoundaryDecision;
  reason: string;
  source: "local_override" | "once_classifier" | "remote_escalation";
}

export interface McpBoundaryPlan {
  serverId: string;
  ready: boolean;
  entries: readonly Readonly<McpBoundaryPlanEntry>[];
  protect: readonly Readonly<McpBoundaryPlanEntry>[];
  bypass: readonly Readonly<McpBoundaryPlanEntry>[];
  unknown: readonly Readonly<McpBoundaryPlanEntry>[];
}

export interface McpBoundaryOverride<Result = unknown> {
  /** Local reviewed routing decision. This is authoritative over remote metadata. */
  decision?: Exclude<McpBoundaryDecision, "UNKNOWN">;
  /** Optional stable identity selector. Its result is cross-checked against identity carriers in input. */
  id?: (input: McpToolArguments) => string;
  /** Optional complete effect-bearing payload selector. */
  payload?: (input: McpToolArguments) => Record<string, unknown>;
  /** Trusted top-level input fields that define logical-operation identity. */
  identityFields?: readonly string[];
  /** Trusted top-level input fields that completely define the external effect. */
  effectFields?: readonly string[];
  /** Read-only authoritative provider truth lookup for an ambiguous protected call. */
  reconcile?: (context: {
    id: string;
    payload: Record<string, unknown>;
  }) => Promise<LocalObservation<Result>> | LocalObservation<Result>;
}

export interface McpExecutionBoundaryOptions<Result = unknown> {
  /** Stable configured identity for one upstream MCP server. */
  serverId: string;
  /** Authoritative MCP tools/list payload or the contained tools array. */
  tools: readonly ConnectToolDescriptor[] | Readonly<{ tools: readonly ConnectToolDescriptor[] }>;
  upstream: McpUpstreamClient<Result>;
  /** Durable local Once state shared across retries/processes. */
  statePath?: string;
  /** Local reviewed policy. Remote tool metadata cannot create these overrides. */
  overrides?: Readonly<Record<string, McpBoundaryOverride<Result> | undefined>>;
}

export interface McpExecutionBoundary<Result = unknown> {
  readonly plan: Readonly<McpBoundaryPlan>;
  /** Exact authoritative tool descriptors to expose to the downstream MCP client. */
  listTools(): Readonly<{ tools: readonly ConnectToolDescriptor[] }>;
  /** The only supported tools/call crossing for this connected upstream server. */
  callTool(request: McpToolCallRequest): Promise<Result>;
}

export class McpExecutionBoundaryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "McpExecutionBoundaryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toolArray(
  value: McpExecutionBoundaryOptions["tools"],
): readonly ConnectToolDescriptor[] | null {
  if (Array.isArray(value)) {
    return value;
  }

  if (isRecord(value) && Array.isArray(value.tools)) {
    return value.tools as readonly ConnectToolDescriptor[];
  }

  return null;
}

function validateFieldList(
  value: readonly string[] | undefined,
  label: string,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(item =>
      typeof item !== "string" ||
      item.trim().length === 0 ||
      item.includes("."),
    )
  ) {
    throw new McpExecutionBoundaryError(
      "INVALID_OVERRIDE",
      `${label} must be a non-empty array of top-level field names.`,
    );
  }

  const normalized = value.map(item => item.trim());

  if (new Set(normalized).size !== normalized.length) {
    throw new McpExecutionBoundaryError(
      "INVALID_OVERRIDE",
      `${label} contains duplicate field names.`,
    );
  }

  return Object.freeze(normalized);
}

function safetyDescriptor(
  serverId: string,
  tool: ConnectToolDescriptor,
  override: McpBoundaryOverride | undefined,
): ConnectToolDescriptor {
  const identityFields = validateFieldList(
    override?.identityFields,
    `${tool.name}.identityFields`,
  );
  const effectFields = validateFieldList(
    override?.effectFields,
    `${tool.name}.effectFields`,
  );

  const once = identityFields || effectFields
    ? {
        ...(identityFields ? { identityFields } : {}),
        ...(effectFields ? { effectFields } : {}),
      }
    : undefined;

  return {
    name: `${serverId}:${tool.name}`,
    ...(typeof tool.description === "string"
      ? { description: tool.description }
      : {}),
    ...(tool.inputSchema !== undefined
      ? { inputSchema: tool.inputSchema }
      : {}),
    ...(once ? { _meta: { once } } : {}),
  };
}

/**
 * Classify an upstream MCP tool without allowing remote annotations to grant a
 * bypass. Remote metadata may only escalate toward protection.
 */
export function classifyRemoteMcpTool(
  tool: ConnectToolDescriptor,
  override?: McpBoundaryOverride,
): Readonly<McpBoundaryPlanEntry> {
  if (
    override?.decision !== undefined &&
    override.decision !== CONNECT_TOOL_DECISION.PROTECT &&
    override.decision !== CONNECT_TOOL_DECISION.BYPASS
  ) {
    throw new McpExecutionBoundaryError(
      "INVALID_OVERRIDE",
      `Invalid local routing decision for ${tool.name}.`,
    );
  }

  if (override?.decision) {
    return Object.freeze({
      name: tool.name,
      decision: override.decision,
      reason: "LOCAL_REVIEWED_OVERRIDE",
      source: "local_override" as const,
    });
  }

  // Strip all remote annotations and _meta before the deterministic classifier.
  // They are untrusted evidence at this boundary, not routing authority.
  const deterministicDescriptor: ConnectToolDescriptor = {
    name: tool.name,
    ...(typeof tool.description === "string"
      ? { description: tool.description }
      : {}),
    ...(tool.inputSchema !== undefined
      ? { inputSchema: tool.inputSchema }
      : {}),
  };

  const classification = classifyConnectTool(deterministicDescriptor);
  const remoteAnnotations = tool.annotations;
  const remoteMutationEscalation =
    remoteAnnotations?.destructiveHint === true ||
    remoteAnnotations?.readOnlyHint === false;

  if (
    classification.decision !== CONNECT_TOOL_DECISION.PROTECT &&
    remoteMutationEscalation
  ) {
    return Object.freeze({
      name: tool.name,
      decision: CONNECT_TOOL_DECISION.PROTECT,
      reason: "REMOTE_METADATA_ESCALATED_TO_PROTECT",
      source: "remote_escalation" as const,
    });
  }

  return Object.freeze({
    name: tool.name,
    decision: classification.decision,
    reason: classification.reason,
    source: "once_classifier" as const,
  });
}

function buildPlan(
  serverId: string,
  tools: readonly ConnectToolDescriptor[],
  overrides: McpExecutionBoundaryOptions["overrides"],
): Readonly<McpBoundaryPlan> {
  const entries = tools.map(tool =>
    classifyRemoteMcpTool(tool, overrides?.[tool.name]),
  );
  const protect = entries.filter(
    entry => entry.decision === CONNECT_TOOL_DECISION.PROTECT,
  );
  const bypass = entries.filter(
    entry => entry.decision === CONNECT_TOOL_DECISION.BYPASS,
  );
  const unknown = entries.filter(
    entry => entry.decision === CONNECT_TOOL_DECISION.UNKNOWN,
  );

  return Object.freeze({
    serverId,
    ready: unknown.length === 0,
    entries: Object.freeze(entries),
    protect: Object.freeze(protect),
    bypass: Object.freeze(bypass),
    unknown: Object.freeze(unknown),
  });
}

function plainArguments(value: unknown): McpToolArguments {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new McpExecutionBoundaryError(
      "INVALID_TOOL_ARGUMENTS",
      "MCP tools/call arguments must be a plain object when present.",
    );
  }

  return value;
}

/**
 * Create one fail-closed MCP execution choke point for a single configured
 * upstream server. Callers must expose only this boundary to the agent; keeping
 * a direct executable path to `upstream.callTool()` is an intentional bypass.
 *
 * Phase 13A invariants:
 * - JSON-RPC/request IDs are transport correlation only;
 * - remote annotations can never downgrade a tool to BYPASS;
 * - UNKNOWN tools never reach the upstream server;
 * - protected calls require stable logical identity before dispatch;
 * - the entire input is effect-bound unless a local reviewed selector narrows it;
 * - retries/replay/UNKNOWN/CONFLICT reuse the existing protectLocal state machine.
 */
export function createMcpExecutionBoundary<Result = unknown>(
  options: McpExecutionBoundaryOptions<Result>,
): Readonly<McpExecutionBoundary<Result>> {
  const serverId = typeof options?.serverId === "string"
    ? options.serverId.trim()
    : "";

  if (!serverId) {
    throw new McpExecutionBoundaryError(
      "INVALID_SERVER_ID",
      "A stable configured MCP server identity is required.",
    );
  }

  if (!options.upstream || typeof options.upstream.callTool !== "function") {
    throw new McpExecutionBoundaryError(
      "INVALID_UPSTREAM",
      "MCP execution boundary requires an upstream callTool implementation.",
    );
  }

  const tools = toolArray(options.tools);

  if (!tools) {
    throw new McpExecutionBoundaryError(
      "INVALID_TOOL_MANIFEST",
      "MCP execution boundary requires an authoritative tools/list result.",
    );
  }

  const descriptors = new Map<string, ConnectToolDescriptor>();

  for (const tool of tools) {
    if (
      !tool ||
      typeof tool !== "object" ||
      typeof tool.name !== "string" ||
      tool.name.trim().length === 0
    ) {
      throw new McpExecutionBoundaryError(
        "INVALID_TOOL_MANIFEST",
        "Every MCP tool needs a stable non-empty name.",
      );
    }

    if (descriptors.has(tool.name)) {
      throw new McpExecutionBoundaryError(
        "DUPLICATE_TOOL_NAME",
        `Duplicate MCP tool name: ${tool.name}.`,
      );
    }

    descriptors.set(tool.name, tool);
  }

  if (options.overrides !== undefined && !isRecord(options.overrides)) {
    throw new McpExecutionBoundaryError(
      "INVALID_OVERRIDE",
      "MCP boundary overrides must be a plain object keyed by tool name.",
    );
  }

  if (options.overrides) {
    for (const name of Object.keys(options.overrides)) {
      if (!descriptors.has(name)) {
        throw new McpExecutionBoundaryError(
          "INVALID_OVERRIDE",
          `Local override refers to undeclared MCP tool ${name}.`,
        );
      }
    }
  }

  // Validate trusted field declarations before any call can be attempted.
  for (const [name, descriptor] of descriptors) {
    safetyDescriptor(serverId, descriptor, options.overrides?.[name]);
  }

  const plan = buildPlan(serverId, tools, options.overrides);
  const publicTools = Object.freeze([...tools]);

  return Object.freeze({
    plan,

    listTools() {
      return Object.freeze({ tools: publicTools });
    },

    async callTool(request: McpToolCallRequest): Promise<Result> {
      if (
        !request ||
        typeof request.name !== "string" ||
        request.name.trim().length === 0
      ) {
        throw new McpExecutionBoundaryError(
          "INVALID_TOOL_CALL",
          "MCP tools/call requires a stable tool name.",
        );
      }

      const descriptor = descriptors.get(request.name);

      if (!descriptor) {
        throw new McpExecutionBoundaryError(
          "TOOL_NOT_FOUND",
          `MCP tool is not present in the authoritative catalog: ${request.name}.`,
        );
      }

      const input = plainArguments(request.arguments);
      const override = options.overrides?.[request.name];
      const route = classifyRemoteMcpTool(descriptor, override);

      if (route.decision === CONNECT_TOOL_DECISION.UNKNOWN) {
        throw new McpExecutionBoundaryError(
          "UNKNOWN_TOOL_SAFETY",
          `Once refuses to call unresolved MCP tool ${request.name}: ${route.reason}.`,
        );
      }

      if (route.decision === CONNECT_TOOL_DECISION.BYPASS) {
        return options.upstream.callTool({
          name: request.name,
          arguments: input,
          ...(request.requestId !== undefined
            ? { requestId: request.requestId }
            : {}),
        });
      }

      const trustedDescriptor = safetyDescriptor(
        serverId,
        descriptor,
        override,
      );

      const protectedCall = protectLocal(
        async (protectedInput: McpToolArguments): Promise<Result> =>
          options.upstream.callTool({
            name: request.name,
            arguments: protectedInput,
            ...(request.requestId !== undefined
              ? { requestId: request.requestId }
              : {}),
          }),
        {
          statePath: options.statePath,
          id: (protectedInput) => {
            const explicitIdentity = override?.id?.(protectedInput);
            const identity = resolveConnectToolOperationIdentity({
              tool: trustedDescriptor,
              input: protectedInput,
              ...(explicitIdentity !== undefined
                ? { explicitIdentity }
                : {}),
            });

            if (identity.status === "FOUND") {
              return identity.operationId;
            }

            if (identity.status === "CONFLICT") {
              throw new McpExecutionBoundaryError(
                "IDENTITY_CONFLICT",
                identity.reason,
              );
            }

            throw new McpExecutionBoundaryError(
              "IDENTITY_REQUIRED",
              identity.reason,
            );
          },
          payload: (protectedInput) => {
            const selected = override?.payload
              ? override.payload(protectedInput)
              : (() => {
                  const payload = resolveConnectToolEffectPayload({
                    tool: trustedDescriptor,
                    input: protectedInput,
                  });

                  if (payload.status !== "FOUND") {
                    throw new McpExecutionBoundaryError(
                      "PAYLOAD_REQUIRED",
                      payload.reason,
                    );
                  }

                  return { ...payload.payload };
                })();

            return {
              serverId,
              tool: request.name,
              effect: selected,
            };
          },
          ...(override?.reconcile
            ? { reconcile: override.reconcile }
            : {}),
        },
      );

      return protectedCall(input);
    },
  });
}

import {
  connectOpenAIAgentsFunctionToolsAuto,
  type ConnectOpenAIAgentsFunctionToolsOptions,
  type OpenAIAgentsFunctionToolLike,
  type OpenAIAgentsFunctionToolOverride,
} from "../connect/openai-function-tools.js";
import type {
  ConnectToolDescriptor,
} from "../connect/tool-classifier.js";
import {
  GatewayConnectionError,
} from "./local-toolset.js";
import {
  GATEWAY_ROUTE,
  planGatewayToolset,
  type GatewayPlan,
} from "./planner.js";
import {
  bindGatewayPlanToToolGraph,
  type BoundGatewayPlan,
  type GatewayToolGraphBinding,
} from "./tool-graph-binding.js";

export interface GatewayOpenAIAgentsFunctionToolsOptions
  extends ConnectOpenAIAgentsFunctionToolsOptions {
  /** Optional exact Tool Graph identities for this model-visible FunctionTool subset. */
  toolGraphBindings?: readonly GatewayToolGraphBinding[];
}

export interface GatewayOpenAIAgentsFunctionTools<
  T extends readonly OpenAIAgentsFunctionToolLike[],
> {
  /** Gateway plan for exactly the supplied FunctionTool subset. */
  plan: Readonly<GatewayPlan>;
  /** Exact Tool Graph binding when supplied. */
  binding?: BoundGatewayPlan;
  /** New FunctionTool objects preserving input order and framework shape. */
  tools: Readonly<{ [K in keyof T]: T[K] }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function blockedSummary(plan: Readonly<GatewayPlan>): string {
  return plan.blocked
    .map(entry => `${entry.name ?? `#${entry.index}`}:${entry.connectReason}`)
    .join(", ");
}

function bindingBlockedSummary(plan: BoundGatewayPlan): string {
  return plan.blocked
    .map(entry => `${entry.name ?? `#${entry.index}`}:${entry.bindingStatus}`)
    .join(", ");
}

function verifyConnectAgreement(
  gatewayPlan: Readonly<GatewayPlan>,
  connectEntries: readonly Readonly<{ decision: string }>[],
): void {
  if (gatewayPlan.entries.length !== connectEntries.length) {
    throw new GatewayConnectionError(
      "GATEWAY_PLAN_MISMATCH",
      "OpenAI Gateway and Connect disagree about the FunctionTool subset length.",
    );
  }

  for (let index = 0; index < gatewayPlan.entries.length; index += 1) {
    const gateway = gatewayPlan.entries[index];
    const expected = gateway.route === GATEWAY_ROUTE.DIRECT
      ? "BYPASS"
      : gateway.route === GATEWAY_ROUTE.PROTECT
        ? "PROTECT"
        : "UNKNOWN";

    if (connectEntries[index]?.decision !== expected) {
      throw new GatewayConnectionError(
        "GATEWAY_PLAN_MISMATCH",
        `OpenAI Gateway and Connect disagree about FunctionTool route index ${index}.`,
      );
    }
  }
}

/**
 * Route an already-selected OpenAI Agents FunctionTool subset through Once.
 *
 * Gateway owns only preflight/routing identity. Actual FunctionTool wrapping,
 * protected input parsing, logical-operation identity, payload binding,
 * replay and reconciliation remain delegated to the existing proven Connect
 * adapter. The supplied subset is never expanded with Tool Graph catalog
 * entries.
 */
export function connectOpenAIAgentsFunctionToolsGatewayAuto<
  T extends readonly OpenAIAgentsFunctionToolLike[],
>(
  tools: T,
  options: GatewayOpenAIAgentsFunctionToolsOptions = {},
): Readonly<GatewayOpenAIAgentsFunctionTools<T>> {
  if (!Array.isArray(tools)) {
    throw new GatewayConnectionError(
      "INVALID_OPENAI_GATEWAY_TOOLSET",
      "Once Gateway needs the runtime-selected OpenAI Agents FunctionTool array.",
    );
  }

  const manifest: ConnectToolDescriptor[] = [];
  const names = new Set<string>();

  for (const candidate of tools) {
    if (!isFunctionToolLike(candidate)) {
      throw new GatewayConnectionError(
        "UNSUPPORTED_OPENAI_GATEWAY_TOOL_TYPE",
        "Once Gateway v1 supports only OpenAI Agents FunctionTool objects in this adapter.",
      );
    }

    if (names.has(candidate.name)) {
      throw new GatewayConnectionError(
        "DUPLICATE_OPENAI_GATEWAY_TOOL_NAME",
        `Once Gateway cannot safely map duplicate OpenAI FunctionTool name "${candidate.name}".`,
      );
    }
    names.add(candidate.name);

    manifest.push(descriptorFor(candidate, options.overrides?.[candidate.name]));
  }

  if (options.overrides) {
    for (const name of Object.keys(options.overrides)) {
      if (!names.has(name)) {
        throw new GatewayConnectionError(
          "UNDECLARED_OPENAI_GATEWAY_OVERRIDE",
          `Gateway override "${name}" does not correspond to a supplied FunctionTool.`,
        );
      }
    }
  }

  const plan = planGatewayToolset(manifest);
  if (!plan.valid) {
    throw new GatewayConnectionError(
      "INVALID_OPENAI_GATEWAY_TOOLSET",
      "Once Gateway could not plan the supplied OpenAI FunctionTool subset.",
    );
  }
  if (!plan.ready) {
    throw new GatewayConnectionError(
      "GATEWAY_BLOCKED",
      `Once Gateway refuses unresolved OpenAI FunctionTool routing: ${blockedSummary(plan)}.`,
    );
  }

  let binding: BoundGatewayPlan | undefined;
  if (options.toolGraphBindings !== undefined) {
    if (!Array.isArray(options.toolGraphBindings)) {
      throw new GatewayConnectionError(
        "INVALID_TOOL_GRAPH_BINDINGS",
        "OpenAI Gateway Tool Graph bindings must be an array of safe identity records.",
      );
    }

    binding = bindGatewayPlanToToolGraph(plan, options.toolGraphBindings);
    if (!binding.ready) {
      throw new GatewayConnectionError(
        "GATEWAY_TOOL_GRAPH_BLOCKED",
        `OpenAI Gateway refuses stale or ambiguous Tool Graph identity: ${bindingBlockedSummary(binding)}.`,
      );
    }
  }

  const {
    toolGraphBindings: _toolGraphBindings,
    ...connectOptions
  } = options;

  const connected = connectOpenAIAgentsFunctionToolsAuto(
    tools,
    connectOptions,
  );

  verifyConnectAgreement(plan, connected.plan.entries);

  if (connected.tools.length !== tools.length) {
    throw new GatewayConnectionError(
      "GATEWAY_SUBSET_MISMATCH",
      "OpenAI Gateway changed the size of the runtime-selected FunctionTool subset.",
    );
  }

  return Object.freeze({
    plan,
    ...(binding ? { binding } : {}),
    tools: connected.tools,
  });
}

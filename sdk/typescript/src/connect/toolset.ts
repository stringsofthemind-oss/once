import {
  normalizeConnectToolManifest,
  planConnectToolManifest,
  type ConnectManifestPlan,
} from "./manifest.js";
import {
  AgentToolConnectionError,
  connectLocalAgentToolAuto,
  type AgentTool,
  type AutoLocalAgentToolContract,
} from "./local-agent-tool.js";
import type {
  ConnectToolDescriptor,
} from "./tool-classifier.js";

type AnyAgentTool = AgentTool<any, any>;

export type LocalAgentToolRegistry =
  Record<string, AnyAgentTool>;

export type ConnectedLocalAgentToolRegistry<
  T extends LocalAgentToolRegistry,
> = {
  readonly [K in keyof T]:
    T[K] extends AgentTool<infer Input, infer Result>
      ? AgentTool<Input, Result>
      : never;
};

export type AutoLocalAgentToolsetOverride =
  Omit<AutoLocalAgentToolContract<any, any>, "descriptor">;

export interface AutoLocalAgentToolsetOptions {
  /** Native/MCP/OpenAI-style manifest accepted by planConnectToolManifest(). */
  manifest: unknown;
  /** Shared default SQLite state path for all connected tools. */
  statePath?: string;
  /** Optional per-tool escape hatches for unusual identity/payload/reconcile needs. */
  overrides?: Readonly<
    Record<string, AutoLocalAgentToolsetOverride | undefined>
  >;
}

export interface ConnectedLocalAgentToolset<
  T extends LocalAgentToolRegistry,
> {
  /** Frozen protection plan used to create this connected registry. */
  plan: Readonly<ConnectManifestPlan>;
  /** Frozen registry. Expose this registry to the agent, not the originals. */
  tools: Readonly<ConnectedLocalAgentToolRegistry<T>>;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(
  value: object,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function formatUnknownTools(
  plan: Readonly<ConnectManifestPlan>,
): string {
  return plan.unknown
    .map(entry => `${entry.name ?? `#${entry.index}`}:${entry.reason}`)
    .join(", ");
}

/**
 * Connect an entire local agent tool registry in one fail-closed operation.
 *
 * Safety properties:
 * - the manifest must fully classify with no UNKNOWN entries;
 * - every declared tool must have exactly one same-named implementation;
 * - undeclared executable registry entries are rejected;
 * - duplicate or invalid tool names are rejected before wrappers are built;
 * - the original registry is never mutated;
 * - every returned tool delegates through connectLocalAgentToolAuto(), so the
 *   existing routing, identity, payload and SQLite protection rules remain the
 *   single source of execution behaviour.
 *
 * Per-call identity/payload can still fail closed at invocation time because
 * those values depend on actual input. Only expose `result.tools` to the agent;
 * retaining and using the original registry remains an intentional bypass.
 */
export function connectLocalAgentToolsetAuto<
  T extends LocalAgentToolRegistry,
>(
  tools: T,
  options: AutoLocalAgentToolsetOptions,
): Readonly<ConnectedLocalAgentToolset<T>> {
  if (!isRecord(tools)) {
    throw new AgentToolConnectionError(
      "INVALID_TOOLSET",
      "Once Connect needs a plain-object registry of named agent tools.",
    );
  }

  if (!options || !("manifest" in options)) {
    throw new AgentToolConnectionError(
      "INVALID_TOOL_MANIFEST",
      "Once Connect needs a complete tool manifest before toolset wiring.",
    );
  }

  const normalized = normalizeConnectToolManifest(options.manifest);
  const plan = planConnectToolManifest(options.manifest);

  if (!normalized || !plan.valid) {
    throw new AgentToolConnectionError(
      "INVALID_TOOL_MANIFEST",
      "Once Connect could not parse the supplied tool manifest.",
    );
  }

  if (!plan.ready) {
    throw new AgentToolConnectionError(
      "UNKNOWN_TOOLSET_SAFETY",
      `Once Connect refuses partial automatic wiring while tool safety is unresolved: ${formatUnknownTools(plan)}.`,
    );
  }

  if (normalized.length !== plan.entries.length) {
    throw new AgentToolConnectionError(
      "INVALID_TOOL_MANIFEST",
      "Once Connect manifest normalization and classification disagree.",
    );
  }

  const descriptors = new Map<string, ConnectToolDescriptor>();

  for (let index = 0; index < normalized.length; index += 1) {
    const item = normalized[index];
    const name = item.name;

    if (
      typeof name !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(name) ||
      !isRecord(item.descriptor)
    ) {
      throw new AgentToolConnectionError(
        "INVALID_TOOL_NAME",
        `Once Connect requires a stable registry-safe tool name at manifest index ${index}.`,
      );
    }

    if (descriptors.has(name)) {
      throw new AgentToolConnectionError(
        "DUPLICATE_TOOL_NAME",
        `Once Connect cannot safely map duplicate manifest tool name "${name}" to one implementation.`,
      );
    }

    descriptors.set(
      name,
      item.descriptor as unknown as ConnectToolDescriptor,
    );
  }

  for (const name of descriptors.keys()) {
    if (!hasOwn(tools, name)) {
      throw new AgentToolConnectionError(
        "MISSING_TOOL_IMPLEMENTATION",
        `The manifest declares "${name}" but the tool registry has no same-named implementation.`,
      );
    }

    const implementation = tools[name];

    if (
      !implementation ||
      typeof implementation.execute !== "function"
    ) {
      throw new AgentToolConnectionError(
        "INVALID_TOOL_IMPLEMENTATION",
        `Tool "${name}" must expose execute(input).`,
      );
    }
  }

  for (const name of Object.keys(tools)) {
    if (!descriptors.has(name)) {
      throw new AgentToolConnectionError(
        "UNDECLARED_TOOL_IMPLEMENTATION",
        `Tool registry entry "${name}" is executable but absent from the manifest. Once refuses to leave an undeclared bypass in the connected registry.`,
      );
    }
  }

  if (
    options.overrides !== undefined &&
    !isRecord(options.overrides)
  ) {
    throw new AgentToolConnectionError(
      "INVALID_TOOLSET_OVERRIDES",
      "Once Connect toolset overrides must be a plain object keyed by tool name.",
    );
  }

  if (options.overrides) {
    for (const name of Object.keys(options.overrides)) {
      if (!descriptors.has(name)) {
        throw new AgentToolConnectionError(
          "UNDECLARED_TOOL_OVERRIDE",
          `Override "${name}" does not correspond to a declared tool.`,
        );
      }

      const override = options.overrides[name];

      if (override !== undefined && !isRecord(override)) {
        throw new AgentToolConnectionError(
          "INVALID_TOOLSET_OVERRIDES",
          `Override "${name}" must be a plain object when provided.`,
        );
      }
    }
  }

  const connected = Object.create(null) as
    ConnectedLocalAgentToolRegistry<T>;

  for (const [name, descriptor] of descriptors) {
    const implementation = tools[name];
    const override = options.overrides?.[name];

    const wrapped = connectLocalAgentToolAuto(
      implementation,
      {
        descriptor,
        statePath: override?.statePath ?? options.statePath,
        id: override?.id,
        payload: override?.payload,
        reconcile: override?.reconcile,
      },
    );

    Object.defineProperty(connected, name, {
      value: Object.freeze(wrapped),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }

  const frozenTools = Object.freeze(connected);

  return Object.freeze({
    plan,
    tools: frozenTools,
  });
}

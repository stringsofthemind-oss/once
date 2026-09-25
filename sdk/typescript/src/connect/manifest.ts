import {
  CONNECT_TOOL_DECISION,
  classifyConnectTool,
  type ConnectToolAnnotations,
  type ConnectToolClassificationReason,
  type ConnectToolDecision,
  type ConnectToolDescriptor,
} from "./tool-classifier.js";

export const CONNECT_MANIFEST_VERSION = "connect-tool-plan-v1" as const;

export type ConnectManifestToolSource =
  | "native"
  | "openai_function"
  | "invalid";

export interface ConnectManifestPlanEntry {
  index: number;
  name: string | null;
  source: ConnectManifestToolSource;
  decision: ConnectToolDecision;
  reason: ConnectToolClassificationReason;
  signals: readonly string[];
}

export interface ConnectManifestPlanSummary {
  total: number;
  protect: number;
  bypass: number;
  unknown: number;
}

export interface ConnectManifestPlan {
  version: typeof CONNECT_MANIFEST_VERSION;
  valid: boolean;
  ready: boolean;
  reason: "CLASSIFIED" | "INVALID_MANIFEST";
  entries: readonly Readonly<ConnectManifestPlanEntry>[];
  protect: readonly Readonly<ConnectManifestPlanEntry>[];
  bypass: readonly Readonly<ConnectManifestPlanEntry>[];
  unknown: readonly Readonly<ConnectManifestPlanEntry>[];
  summary: Readonly<ConnectManifestPlanSummary>;
}

/** Internal normalized representation shared by manifest planning and toolset wiring. */
export interface NormalizedConnectManifestTool {
  descriptor: unknown;
  name: string | null;
  source: ConnectManifestToolSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function normalizeManifestInput(manifest: unknown): readonly unknown[] | null {
  if (Array.isArray(manifest)) {
    return manifest;
  }

  if (isRecord(manifest) && Array.isArray(manifest.tools)) {
    return manifest.tools;
  }

  return null;
}

function normalizedAnnotations(
  value: unknown,
): ConnectToolAnnotations | undefined {
  return isRecord(value)
    ? value as ConnectToolAnnotations
    : undefined;
}

function normalizedMeta(
  value: unknown,
): Record<string, unknown> | undefined {
  return isRecord(value)
    ? value
    : undefined;
}

function normalizeTool(tool: unknown): NormalizedConnectManifestTool {
  if (!isRecord(tool)) {
    return {
      descriptor: tool,
      name: null,
      source: "invalid",
    };
  }

  if (
    typeof tool.name === "string" &&
    tool.name.trim().length > 0
  ) {
    return {
      descriptor: tool,
      name: tool.name,
      source: "native",
    };
  }

  if (
    tool.type === "function" &&
    isRecord(tool.function) &&
    typeof tool.function.name === "string" &&
    tool.function.name.trim().length > 0
  ) {
    const fn = tool.function;
    const name = tool.function.name;
    const annotations = normalizedAnnotations(tool.annotations);
    const meta = normalizedMeta(tool._meta) ?? normalizedMeta(fn._meta);

    const descriptor: ConnectToolDescriptor = {
      name,
      ...(typeof fn.description === "string"
        ? { description: fn.description }
        : {}),
      ...(fn.parameters !== undefined
        ? { inputSchema: fn.parameters }
        : {}),
      ...(annotations !== undefined
        ? { annotations }
        : {}),
      ...(meta !== undefined
        ? { _meta: meta }
        : {}),
    };

    return {
      descriptor,
      name,
      source: "openai_function",
    };
  }

  return {
    descriptor: tool,
    name: null,
    source: "invalid",
  };
}

/**
 * Normalize the same manifest shapes accepted by planConnectToolManifest().
 *
 * This is exported for internal Connect modules so classification and wiring
 * cannot silently disagree about the descriptor being inspected. It is not
 * re-exported from the public @once-agent/sdk/connect entry point.
 */
export function normalizeConnectToolManifest(
  manifest: unknown,
): readonly NormalizedConnectManifestTool[] | null {
  const tools = normalizeManifestInput(manifest);

  if (!tools) {
    return null;
  }

  return Object.freeze(
    tools.map(tool => Object.freeze(normalizeTool(tool))),
  );
}

function freezeEntry(
  entry: ConnectManifestPlanEntry,
): Readonly<ConnectManifestPlanEntry> {
  return Object.freeze({
    ...entry,
    signals: Object.freeze([...entry.signals]),
  });
}

function invalidPlan(): Readonly<ConnectManifestPlan> {
  const entries = Object.freeze([]) as readonly Readonly<ConnectManifestPlanEntry>[];
  const summary = Object.freeze({
    total: 0,
    protect: 0,
    bypass: 0,
    unknown: 0,
  });

  return Object.freeze({
    version: CONNECT_MANIFEST_VERSION,
    valid: false,
    ready: false,
    reason: "INVALID_MANIFEST" as const,
    entries,
    protect: entries,
    bypass: entries,
    unknown: entries,
    summary,
  });
}

/**
 * Inspect a complete tool manifest and produce an ordered Once protection plan.
 *
 * Accepted inputs:
 * - an array of native/MCP-style tool descriptors;
 * - an MCP-style `{ tools: [...] }` result;
 * - OpenAI-style `{ type: "function", function: { ... } }` entries.
 *
 * `ready` is true only when every entry has a deterministic PROTECT/BYPASS
 * decision. UNKNOWN never becomes implicit permission.
 */
export function planConnectToolManifest(
  manifest: unknown,
): Readonly<ConnectManifestPlan> {
  const tools = normalizeConnectToolManifest(manifest);

  if (!tools) {
    return invalidPlan();
  }

  const entries = tools.map((tool, index) => {
    const classification = classifyConnectTool(tool.descriptor);

    return freezeEntry({
      index,
      name: tool.name,
      source: tool.source,
      decision: classification.decision,
      reason: classification.reason,
      signals: classification.signals,
    });
  });

  const protect = entries.filter(
    entry => entry.decision === CONNECT_TOOL_DECISION.PROTECT,
  );

  const bypass = entries.filter(
    entry => entry.decision === CONNECT_TOOL_DECISION.BYPASS,
  );

  const unknown = entries.filter(
    entry => entry.decision === CONNECT_TOOL_DECISION.UNKNOWN,
  );

  const summary = Object.freeze({
    total: entries.length,
    protect: protect.length,
    bypass: bypass.length,
    unknown: unknown.length,
  });

  return Object.freeze({
    version: CONNECT_MANIFEST_VERSION,
    valid: true,
    ready: unknown.length === 0,
    reason: "CLASSIFIED" as const,
    entries: Object.freeze(entries),
    protect: Object.freeze(protect),
    bypass: Object.freeze(bypass),
    unknown: Object.freeze(unknown),
    summary,
  });
}

import {
  CONNECT_TOOL_DECISION,
  classifyConnectTool,
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

interface NormalizedConnectManifestTool {
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

    const descriptor: ConnectToolDescriptor = {
      name: fn.name,
      ...(typeof fn.description === "string"
        ? { description: fn.description }
        : {}),
      ...(fn.parameters !== undefined
        ? { inputSchema: fn.parameters }
        : {}),
    };

    return {
      descriptor,
      name: fn.name,
      source: "openai_function",
    };
  }

  return {
    descriptor: tool,
    name: null,
    source: "invalid",
  };
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
  const tools = normalizeManifestInput(manifest);

  if (!tools) {
    return invalidPlan();
  }

  const entries = tools.map((tool, index) => {
    const normalized = normalizeTool(tool);
    const classification = classifyConnectTool(normalized.descriptor);

    return freezeEntry({
      index,
      name: normalized.name,
      source: normalized.source,
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

import path from "node:path";

import {
  discoverToolGraph,
  type ToolGraphRecord
} from "./tool-discovery.js";

import type {
  ToolActionBand,
  ToolEffectClass,
  ToolEvidenceLevel,
  ToolImportanceBand,
  ToolProtectionState
} from "./tool-importance.js";

export type MonitorHealth =
  | "READY"
  | "ATTENTION"
  | "NO_TOOLS_OBSERVED";

export type MonitorToolSnapshot = {
  toolId: string;
  name: string;
  framework?: string;
  evidenceLevel: ToolEvidenceLevel;
  effectClass: ToolEffectClass;
  importanceBand: ToolImportanceBand;
  action: ToolActionBand;
  protection: ToolProtectionState;
  visibility: {
    configured: boolean;
    runtimeRegistered: boolean;
    modelVisible: boolean;
    executed: boolean;
  };
};

export type MonitorSnapshot = {
  schema: "once.monitor.snapshot.v1";
  generatedAt: string;
  project: {
    name: string;
  };
  environment: {
    nodeVersion: string;
    languages: string[];
    tooling: string[];
  };
  health: MonitorHealth;
  summary: {
    configuredSources: number;
    toolsDiscovered: number;
    modelVisible: number;
    executionEvidence: number;
    readOnly: number;
    protected: number;
    needsAttention: number;
    unknown: number;
  };
  tools: MonitorToolSnapshot[];
  capabilities: {
    chronologicalActivityFeed: false;
  };
  privacy: {
    localReadOnly: true;
    sourceUploaded: false;
    secretValuesIncluded: false;
    payloadsIncluded: false;
    absolutePathsIncluded: false;
  };
};

const protectedStates =
  new Set<ToolProtectionState>([
    "NATIVE_IDEMPOTENCY",
    "AUTHORITATIVE_RECONCILIATION",
    "ONCE_HEALTHY"
  ]);

const attentionActions =
  new Set<ToolActionBand>([
    "CRITICAL_GAP",
    "PROTECT_PRIORITY"
  ]);

function safeTool(
  tool: ToolGraphRecord
): MonitorToolSnapshot {
  return {
    toolId: tool.toolId,
    name: tool.displayName,
    ...(tool.framework
      ? { framework: tool.framework }
      : {}),
    evidenceLevel: tool.evidence.level,
    effectClass: tool.once.effectClass,
    importanceBand: tool.once.criticality.band,
    action: tool.once.actionPriority.band,
    protection: tool.once.protection,
    visibility: {
      configured: tool.visibility.configured,
      runtimeRegistered: tool.visibility.runtimeRegistered,
      modelVisible: tool.visibility.modelVisible,
      executed: tool.visibility.executed
    }
  };
}

export async function createMonitorSnapshot(
  requestedPath: string
): Promise<MonitorSnapshot> {
  const discovery =
    await discoverToolGraph(requestedPath);
  const tools =
    discovery.tools.map(safeTool);

  const protectedCount =
    tools.filter(
      tool => protectedStates.has(tool.protection)
    ).length;

  const needsAttention =
    tools.filter(
      tool => attentionActions.has(tool.action)
    ).length;

  const readOnly =
    tools.filter(
      tool =>
        tool.effectClass === "READ_ONLY" ||
        tool.effectClass === "GENERATION_ONLY"
    ).length;

  const unknown =
    tools.filter(
      tool =>
        tool.effectClass === "UNKNOWN" ||
        tool.action === "REVIEW" ||
        tool.action === "QUALIFY"
    ).length;

  const health: MonitorHealth =
    needsAttention > 0
      ? "ATTENTION"
      : tools.length === 0 &&
          discovery.configuredSources.length === 0
        ? "NO_TOOLS_OBSERVED"
        : "READY";

  return {
    schema: "once.monitor.snapshot.v1",
    generatedAt: new Date().toISOString(),
    project: {
      // Deliberately expose only the final directory name. Monitor does not
      // need a customer's absolute path merely to render status.
      name: path.basename(
        path.resolve(discovery.root)
      ) || "project"
    },
    environment: {
      nodeVersion: process.versions.node,
      languages: [...discovery.languages],
      tooling: [...discovery.tooling]
    },
    health,
    summary: {
      configuredSources:
        discovery.configuredSources.length,
      toolsDiscovered: tools.length,
      modelVisible:
        tools.filter(
          tool => tool.visibility.modelVisible
        ).length,
      executionEvidence:
        tools.filter(
          tool => tool.visibility.executed
        ).length,
      readOnly,
      protected: protectedCount,
      needsAttention,
      unknown
    },
    tools,
    capabilities: {
      // Tool Graph can record execution evidence, but it is not a durable
      // chronological activity log. Monitor must never invent timestamps.
      chronologicalActivityFeed: false
    },
    privacy: {
      localReadOnly: true,
      sourceUploaded: false,
      secretValuesIncluded: false,
      payloadsIncluded: false,
      absolutePathsIncluded: false
    }
  };
}

export async function printMonitorSnapshot(
  requestedPath: string
): Promise<void> {
  const snapshot =
    await createMonitorSnapshot(requestedPath);

  process.stdout.write(
    JSON.stringify(snapshot) + "\n"
  );
}

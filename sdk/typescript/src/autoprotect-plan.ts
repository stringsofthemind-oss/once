import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ToolActionBand
} from "./tool-importance.js";

import {
  discoverToolGraph,
  type ToolDiscoveryResult
} from "./tool-discovery.js";

export type AutoprotectDisposition =
  | "BYPASS_CANDIDATE"
  | "PROTECT_REQUIRED"
  | "BLOCK_PENDING_REVIEW";

export type AutoprotectPlanEntry = {
  tool_id: string;
  canonical_name: string;
  display_name: string;
  framework: string | null;
  evidence_level: string;
  effect_class: string;
  action_band: ToolActionBand;
  protection_state: string;
  disposition: AutoprotectDisposition;
  reasons: string[];
};

export type AutoprotectPlan = {
  schema_version: 1;
  generated_at: string;
  project: string;
  mode: "PLAN_ONLY";
  source_modified: false;
  provider_contacted: false;
  tool_invocation_performed: false;
  execution_authority:
    "EXISTING_CONNECT_GATEWAY_PROTECTLOCAL_RUNTIME";
  summary: {
    total: number;
    bypass_candidates: number;
    protect_required: number;
    blocked_pending_review: number;
    configured_tool_sources: number;
  };
  tooling: string[];
  configured_sources: Array<{
    source_id: string;
    host: string;
    name: string;
    scope: string;
    transport: string;
    status: string;
    planned_path: "MCP_PROXY_REVIEW";
  }>;
  entries: AutoprotectPlanEntry[];
};

function dispositionForBand(
  band: ToolActionBand
): AutoprotectDisposition {
  switch (band) {
    case "BYPASS":
    case "OBSERVE":
      return "BYPASS_CANDIDATE";

    case "PROTECT_PRIORITY":
    case "CRITICAL_GAP":
      return "PROTECT_REQUIRED";

    case "REVIEW":
    case "QUALIFY":
    default:
      return "BLOCK_PENDING_REVIEW";
  }
}

function buildPlan(
  root: string,
  discovery: ToolDiscoveryResult
): AutoprotectPlan {
  const entries =
    discovery.tools.map(
      tool => {
        const band =
          tool.once.actionPriority.band;

        return {
          tool_id:
            tool.toolId,
          canonical_name:
            tool.canonicalName,
          display_name:
            tool.displayName,
          framework:
            tool.framework ?? null,
          evidence_level:
            tool.evidence.level,
          effect_class:
            tool.once.effectClass,
          action_band:
            band,
          protection_state:
            tool.once.protection,
          disposition:
            dispositionForBand(band),
          reasons:
            [...tool.once.actionPriority.reasons]
        } satisfies AutoprotectPlanEntry;
      }
    );

  const bypassCandidates =
    entries.filter(
      entry =>
        entry.disposition ===
        "BYPASS_CANDIDATE"
    ).length;

  const protectRequired =
    entries.filter(
      entry =>
        entry.disposition ===
        "PROTECT_REQUIRED"
    ).length;

  const blockedPendingReview =
    entries.filter(
      entry =>
        entry.disposition ===
        "BLOCK_PENDING_REVIEW"
    ).length;

  return {
    schema_version: 1,
    generated_at:
      new Date().toISOString(),
    project: root,
    mode: "PLAN_ONLY",
    source_modified: false,
    provider_contacted: false,
    tool_invocation_performed: false,
    execution_authority:
      "EXISTING_CONNECT_GATEWAY_PROTECTLOCAL_RUNTIME",
    summary: {
      total:
        entries.length,
      bypass_candidates:
        bypassCandidates,
      protect_required:
        protectRequired,
      blocked_pending_review:
        blockedPendingReview,
      configured_tool_sources:
        discovery.configuredSources.length
    },
    tooling:
      [...discovery.tooling],
    configured_sources:
      discovery.configuredSources.map(
        source => ({
          source_id:
            source.sourceId,
          host:
            source.host,
          name:
            source.name,
          scope:
            source.scope,
          transport:
            source.transport,
          status:
            source.status,
          planned_path:
            "MCP_PROXY_REVIEW" as const
        })
      ),
    entries
  };
}

export async function writeAutoprotectPlan(
  requestedPath: string,
  discoveryResult?: ToolDiscoveryResult
): Promise<AutoprotectPlan> {
  const root =
    path.resolve(requestedPath);

  const discovery =
    discoveryResult ??
    await discoverToolGraph(root);

  const plan =
    buildPlan(root, discovery);

  const onceDirectory =
    path.join(root, ".once");

  await fs.mkdir(
    onceDirectory,
    {
      recursive: true
    }
  );

  const planPath =
    path.join(
      onceDirectory,
      "autoprotect-plan.json"
    );

  await fs.writeFile(
    planPath,
    JSON.stringify(
      plan,
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log("");
  console.log("AUTOMATIC WIRING PLAN");
  console.log("---------------------");
  console.log(
    `Plan written: ${planPath}`
  );
  console.log(
    `BYPASS candidates: ${plan.summary.bypass_candidates}`
  );
  console.log(
    `Protection required: ${plan.summary.protect_required}`
  );
  console.log(
    `Blocked pending review: ${plan.summary.blocked_pending_review}`
  );
  console.log(
    "Plan only: no tool was invoked, no provider was contacted, and no application source was modified."
  );
  console.log(
    "Execution authority remains the existing Connect/Gateway/protectLocal/runtime safety paths."
  );

  return plan;
}

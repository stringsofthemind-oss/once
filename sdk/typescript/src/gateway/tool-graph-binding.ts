import type {
  ToolEvidenceLevel,
  ToolProtectionState,
} from "../tool-importance.js";
import {
  GATEWAY_ROUTE,
  type GatewayPlan,
  type GatewayPlanEntry,
  type GatewayRoute,
} from "./planner.js";

export type GatewayToolGraphBinding = Readonly<{
  toolId: string;
  namespacedName: string;
  canonicalName: string;
  descriptorFingerprint: string;
  evidenceLevel: ToolEvidenceLevel;
  actionPriorityScore?: number;
  protection?: ToolProtectionState;
}>;

export type GatewayToolGraphBindingStatus =
  | "MATCHED"
  | "MISSING"
  | "FINGERPRINT_MISMATCH"
  | "AMBIGUOUS"
  | "NOT_ROUTABLE";

export type BoundGatewayPlanEntry = Readonly<{
  index: number;
  name: string | null;
  plannedRoute: GatewayRoute;
  route: GatewayRoute;
  descriptorFingerprint: string;
  bindingStatus: GatewayToolGraphBindingStatus;
  toolGraph?: GatewayToolGraphBinding;
}>;

export type BoundGatewayPlanSummary = Readonly<{
  total: number;
  matched: number;
  missing: number;
  fingerprintMismatch: number;
  ambiguous: number;
  blocked: number;
}>;

export type BoundGatewayPlan = Readonly<{
  valid: boolean;
  ready: boolean;
  entries: readonly BoundGatewayPlanEntry[];
  matched: readonly BoundGatewayPlanEntry[];
  blocked: readonly BoundGatewayPlanEntry[];
  summary: BoundGatewayPlanSummary;
}>;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validScore(value: unknown): value is number | undefined {
  return value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);
}

const evidenceLevels = new Set<ToolEvidenceLevel>([
  "EXECUTED",
  "MODEL_VISIBLE",
  "RUNTIME_REGISTERED",
  "SERVER_AUTHORITATIVE",
  "HOST_CONFIGURED",
  "SOURCE_DISCOVERED",
  "REGISTRY_CANDIDATE",
]);

const protectionStates = new Set<ToolProtectionState>([
  "NONE",
  "NATIVE_IDEMPOTENCY",
  "AUTHORITATIVE_RECONCILIATION",
  "ONCE_HEALTHY",
  "ONCE_UNVERIFIED",
]);

function normalizeBinding(value: unknown): GatewayToolGraphBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    !nonEmptyString(record.toolId) ||
    !nonEmptyString(record.namespacedName) ||
    !nonEmptyString(record.canonicalName) ||
    !nonEmptyString(record.descriptorFingerprint) ||
    !evidenceLevels.has(record.evidenceLevel as ToolEvidenceLevel) ||
    !validScore(record.actionPriorityScore) ||
    (
      record.protection !== undefined &&
      !protectionStates.has(record.protection as ToolProtectionState)
    )
  ) {
    return undefined;
  }

  return Object.freeze({
    toolId: record.toolId,
    namespacedName: record.namespacedName,
    canonicalName: record.canonicalName,
    descriptorFingerprint: record.descriptorFingerprint,
    evidenceLevel: record.evidenceLevel as ToolEvidenceLevel,
    ...(record.actionPriorityScore !== undefined
      ? { actionPriorityScore: record.actionPriorityScore as number }
      : {}),
    ...(record.protection !== undefined
      ? { protection: record.protection as ToolProtectionState }
      : {}),
  });
}

function blockedEntry(
  entry: Readonly<GatewayPlanEntry>,
  bindingStatus: GatewayToolGraphBindingStatus,
): BoundGatewayPlanEntry {
  return Object.freeze({
    index: entry.index,
    name: entry.name,
    plannedRoute: entry.route,
    route: GATEWAY_ROUTE.BLOCK,
    descriptorFingerprint: entry.descriptorFingerprint,
    bindingStatus,
  });
}

/**
 * Bind a gateway route plan to safe Tool Graph identity records.
 *
 * Binding is intentionally stricter than name matching: one and only one
 * Tool Graph record must match both canonical name and the exact gateway
 * descriptor fingerprint. Evidence/protection state is retained only for
 * reporting; it never downgrades a PROTECT route to DIRECT.
 *
 * The caller may pass a larger/global Tool Graph binding set. Unrelated
 * entries are ignored, so binding the selected runtime subset does not force
 * the global catalog into model context or into the returned plan.
 */
export function bindGatewayPlanToToolGraph(
  plan: Readonly<GatewayPlan>,
  bindings: readonly unknown[],
): BoundGatewayPlan {
  const normalized = Array.isArray(bindings)
    ? bindings
        .map(normalizeBinding)
        .filter((binding): binding is GatewayToolGraphBinding => Boolean(binding))
    : [];

  const entries = plan.entries.map(entry => {
    if (entry.route === GATEWAY_ROUTE.BLOCK || !entry.name) {
      return blockedEntry(entry, "NOT_ROUTABLE");
    }

    const sameName = normalized.filter(
      binding => binding.canonicalName === entry.name,
    );
    const exact = sameName.filter(
      binding => binding.descriptorFingerprint === entry.descriptorFingerprint,
    );

    if (exact.length > 1) {
      return blockedEntry(entry, "AMBIGUOUS");
    }

    if (exact.length === 0) {
      return blockedEntry(
        entry,
        sameName.length > 0 ? "FINGERPRINT_MISMATCH" : "MISSING",
      );
    }

    return Object.freeze({
      index: entry.index,
      name: entry.name,
      plannedRoute: entry.route,
      route: entry.route,
      descriptorFingerprint: entry.descriptorFingerprint,
      bindingStatus: "MATCHED" as const,
      toolGraph: exact[0],
    });
  });

  const matched = entries.filter(entry => entry.bindingStatus === "MATCHED");
  const blocked = entries.filter(entry => entry.route === GATEWAY_ROUTE.BLOCK);
  const summary = Object.freeze({
    total: entries.length,
    matched: matched.length,
    missing: entries.filter(entry => entry.bindingStatus === "MISSING").length,
    fingerprintMismatch: entries.filter(
      entry => entry.bindingStatus === "FINGERPRINT_MISMATCH",
    ).length,
    ambiguous: entries.filter(entry => entry.bindingStatus === "AMBIGUOUS").length,
    blocked: blocked.length,
  });

  return Object.freeze({
    valid: plan.valid,
    ready: plan.valid && plan.ready && blocked.length === 0,
    entries: Object.freeze(entries),
    matched: Object.freeze(matched),
    blocked: Object.freeze(blocked),
    summary,
  });
}

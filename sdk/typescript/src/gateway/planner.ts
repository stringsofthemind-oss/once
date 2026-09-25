import { createHash } from "node:crypto";

import {
  normalizeConnectToolManifest,
  planConnectToolManifest,
  type ConnectManifestToolSource,
} from "../connect/manifest.js";
import {
  CONNECT_TOOL_DECISION,
  type ConnectToolClassificationReason,
  type ConnectToolDecision,
} from "../connect/tool-classifier.js";

export const GATEWAY_ROUTE = Object.freeze({
  DIRECT: "DIRECT",
  PROTECT: "PROTECT",
  BLOCK: "BLOCK",
} as const);

export type GatewayRoute =
  (typeof GATEWAY_ROUTE)[keyof typeof GATEWAY_ROUTE];

export const GATEWAY_PLAN_VERSION = "once-gateway-plan-v1" as const;

export interface GatewayPlanEntry {
  index: number;
  name: string | null;
  source: ConnectManifestToolSource;
  route: GatewayRoute;
  descriptorFingerprint: string;
  connectDecision: ConnectToolDecision;
  connectReason: ConnectToolClassificationReason;
  signals: readonly string[];
}

export interface GatewayPlanSummary {
  total: number;
  direct: number;
  protect: number;
  blocked: number;
}

export interface GatewayPlan {
  version: typeof GATEWAY_PLAN_VERSION;
  valid: boolean;
  ready: boolean;
  reason: "PLANNED" | "INVALID_MANIFEST";
  entries: readonly Readonly<GatewayPlanEntry>[];
  direct: readonly Readonly<GatewayPlanEntry>[];
  protect: readonly Readonly<GatewayPlanEntry>[];
  blocked: readonly Readonly<GatewayPlanEntry>[];
  summary: Readonly<GatewayPlanSummary>;
}

const secretNamePattern =
  /(?:^|[_-])(authorization|api[_-]?key|token|password|passwd|secret|credential|cookie)(?:$|[_-])/i;

function canonicalGatewayValue(
  value: unknown,
  depth = 0,
  seen: Set<object> = new Set(),
  secretContext = false,
): unknown {
  if (secretContext) return "<redacted>";

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "object" || depth > 12) {
    return "<opaque>";
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) return "<cycle>";
  seen.add(objectValue);

  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        output.push(
          descriptor && "value" in descriptor
            ? canonicalGatewayValue(descriptor.value, depth + 1, seen)
            : "<opaque>",
        );
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return "<opaque>";
    }

    const output: Record<string, unknown> = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);

    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor)) {
        output[key] = "<opaque>";
        continue;
      }

      output[key] = canonicalGatewayValue(
        descriptor.value,
        depth + 1,
        seen,
        secretNamePattern.test(key),
      );
    }

    return output;
  } finally {
    seen.delete(objectValue);
  }
}

/**
 * Stable, secret-safe fingerprint of the exact descriptor shape used for
 * gateway routing. Getter-backed/non-plain runtime state is never evaluated.
 */
export function gatewayDescriptorFingerprint(
  descriptor: unknown,
): string {
  const canonical = canonicalGatewayValue(descriptor);
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

function mapRoute(decision: ConnectToolDecision): GatewayRoute {
  if (decision === CONNECT_TOOL_DECISION.BYPASS) {
    return GATEWAY_ROUTE.DIRECT;
  }
  if (decision === CONNECT_TOOL_DECISION.PROTECT) {
    return GATEWAY_ROUTE.PROTECT;
  }
  return GATEWAY_ROUTE.BLOCK;
}

function freezeEntry(entry: GatewayPlanEntry): Readonly<GatewayPlanEntry> {
  return Object.freeze({
    ...entry,
    signals: Object.freeze([...entry.signals]),
  });
}

function invalidPlan(): Readonly<GatewayPlan> {
  const entries = Object.freeze([]) as readonly Readonly<GatewayPlanEntry>[];
  const summary = Object.freeze({
    total: 0,
    direct: 0,
    protect: 0,
    blocked: 0,
  });

  return Object.freeze({
    version: GATEWAY_PLAN_VERSION,
    valid: false,
    ready: false,
    reason: "INVALID_MANIFEST" as const,
    entries,
    direct: entries,
    protect: entries,
    blocked: entries,
    summary,
  });
}

/**
 * Plan how a runtime-selected tool subset should cross the Once Gateway.
 *
 * This is a pure control-plane operation. It does not execute tools, resolve
 * per-invocation operation identity/effect payload, open local protection
 * state, contact MCP/providers, or retain executable implementations.
 *
 * Existing Connect classification remains authoritative:
 * BYPASS -> DIRECT, PROTECT -> PROTECT, UNKNOWN -> BLOCK.
 */
export function planGatewayToolset(
  manifest: unknown,
): Readonly<GatewayPlan> {
  const normalized = normalizeConnectToolManifest(manifest);
  const connectPlan = planConnectToolManifest(manifest);

  if (
    !normalized ||
    !connectPlan.valid ||
    normalized.length !== connectPlan.entries.length
  ) {
    return invalidPlan();
  }

  const entries = connectPlan.entries.map((connectEntry, index) => {
    const normalizedEntry = normalized[index];

    return freezeEntry({
      index,
      name: connectEntry.name,
      source: connectEntry.source,
      route: mapRoute(connectEntry.decision),
      descriptorFingerprint: gatewayDescriptorFingerprint(
        normalizedEntry.descriptor,
      ),
      connectDecision: connectEntry.decision,
      connectReason: connectEntry.reason,
      signals: connectEntry.signals,
    });
  });

  const direct = entries.filter(
    entry => entry.route === GATEWAY_ROUTE.DIRECT,
  );
  const protect = entries.filter(
    entry => entry.route === GATEWAY_ROUTE.PROTECT,
  );
  const blocked = entries.filter(
    entry => entry.route === GATEWAY_ROUTE.BLOCK,
  );

  const summary = Object.freeze({
    total: entries.length,
    direct: direct.length,
    protect: protect.length,
    blocked: blocked.length,
  });

  return Object.freeze({
    version: GATEWAY_PLAN_VERSION,
    valid: true,
    ready: blocked.length === 0,
    reason: "PLANNED" as const,
    entries: Object.freeze(entries),
    direct: Object.freeze(direct),
    protect: Object.freeze(protect),
    blocked: Object.freeze(blocked),
    summary,
  });
}

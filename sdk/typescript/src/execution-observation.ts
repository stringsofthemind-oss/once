import {
  assessToolImportance,
  type ToolEvidenceLevel,
  type ToolImportanceAssessment,
} from "./tool-importance.js";

export type ToolExecutionStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN";

export type ToolExecutionSource =
  | "framework_callback"
  | "otel"
  | "adapter";

export type ToolExecutionObservationInput = {
  eventId?: string;
  toolId?: string;
  namespacedName?: string;
  canonicalName?: string;
  framework?: string;
  runtimeName?: string;
  source: ToolExecutionSource;
  status: ToolExecutionStatus;
  observedAt?: string;
  durationMs?: number;
};

export type ToolExecutionObservation = Readonly<{
  eventId?: string;
  toolId?: string;
  namespacedName?: string;
  canonicalName?: string;
  framework?: string;
  runtimeName?: string;
  source: ToolExecutionSource;
  status: ToolExecutionStatus;
  observedAt: string;
  durationMs?: number;
}>;

export type ToolExecutionObservationRejection = Readonly<{
  accepted: false;
  reason:
    | "INVALID_EVENT"
    | "IDENTITY_REQUIRED"
    | "INVALID_STATUS"
    | "INVALID_SOURCE"
    | "INVALID_TIMESTAMP"
    | "INVALID_DURATION";
}>;

export type ToolExecutionObservationAcceptance = Readonly<{
  accepted: true;
  event: ToolExecutionObservation;
}>;

export type ToolExecutionObservationResult =
  | ToolExecutionObservationAcceptance
  | ToolExecutionObservationRejection;

export type ToolExecutionSummary = Readonly<{
  identityKey: string;
  toolId?: string;
  namespacedName?: string;
  canonicalName?: string;
  framework?: string;
  runtimeName?: string;
  callCount: number;
  succeededCount: number;
  failedCount: number;
  unknownCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  latestStatus: ToolExecutionStatus;
  totalDurationMs?: number;
  averageDurationMs?: number;
  sources: readonly ToolExecutionSource[];
}>;

export type ToolExecutionAggregate = Readonly<{
  summaries: readonly ToolExecutionSummary[];
  acceptedEventCount: number;
  rejectedEventCount: number;
  duplicateEventCount: number;
}>;

export type ExecutionPromotableTool = {
  toolId: string;
  namespacedName: string;
  canonicalName: string;
  description?: string;
  toolType?: string;
  evidence: {
    level: ToolEvidenceLevel;
    source: string;
  };
  visibility: {
    configured: boolean;
    runtimeRegistered: boolean;
    modelVisible: boolean;
    executed: boolean;
  };
  once: ToolImportanceAssessment;
};

export type ExecutedToolObservation<T extends ExecutionPromotableTool> =
  Omit<T, "evidence" | "visibility" | "once"> & {
    evidence: {
      level: "EXECUTED";
      source: string;
    };
    visibility: T["visibility"] & {
      executed: true;
    };
    execution: ToolExecutionSummary;
    once: ToolImportanceAssessment;
  };

const VALID_STATUS = new Set<ToolExecutionStatus>([
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
]);

const VALID_SOURCE = new Set<ToolExecutionSource>([
  "framework_callback",
  "otel",
  "adapter",
]);

function ownDataValue(
  value: unknown,
  key: string,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  if (value === undefined) {
    return new Date().toISOString();
  }

  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;

  return new Date(time).toISOString();
}

/**
 * Convert callback/telemetry metadata into a secret-minimal execution event.
 *
 * This function intentionally whitelists fields. Tool arguments, prompts,
 * results, error messages, auth data, callbacks and runtime objects are never
 * copied into the observation, even when present on the input object.
 */
export function observeToolExecution(
  input: unknown,
): ToolExecutionObservationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return Object.freeze({
      accepted: false,
      reason: "INVALID_EVENT",
    });
  }

  const toolId = optionalString(ownDataValue(input, "toolId"));
  const namespacedName = optionalString(
    ownDataValue(input, "namespacedName"),
  );

  if (!toolId && !namespacedName) {
    return Object.freeze({
      accepted: false,
      reason: "IDENTITY_REQUIRED",
    });
  }

  const status = ownDataValue(input, "status");
  if (typeof status !== "string" || !VALID_STATUS.has(status as ToolExecutionStatus)) {
    return Object.freeze({
      accepted: false,
      reason: "INVALID_STATUS",
    });
  }

  const source = ownDataValue(input, "source");
  if (typeof source !== "string" || !VALID_SOURCE.has(source as ToolExecutionSource)) {
    return Object.freeze({
      accepted: false,
      reason: "INVALID_SOURCE",
    });
  }

  const observedAt = validTimestamp(ownDataValue(input, "observedAt"));
  if (!observedAt) {
    return Object.freeze({
      accepted: false,
      reason: "INVALID_TIMESTAMP",
    });
  }

  const rawDuration = ownDataValue(input, "durationMs");
  if (
    rawDuration !== undefined &&
    (
      typeof rawDuration !== "number" ||
      !Number.isFinite(rawDuration) ||
      rawDuration < 0
    )
  ) {
    return Object.freeze({
      accepted: false,
      reason: "INVALID_DURATION",
    });
  }

  const event: ToolExecutionObservation = Object.freeze({
    ...(optionalString(ownDataValue(input, "eventId"))
      ? { eventId: optionalString(ownDataValue(input, "eventId")) }
      : {}),
    ...(toolId ? { toolId } : {}),
    ...(namespacedName ? { namespacedName } : {}),
    ...(optionalString(ownDataValue(input, "canonicalName"))
      ? { canonicalName: optionalString(ownDataValue(input, "canonicalName")) }
      : {}),
    ...(optionalString(ownDataValue(input, "framework"))
      ? { framework: optionalString(ownDataValue(input, "framework")) }
      : {}),
    ...(optionalString(ownDataValue(input, "runtimeName"))
      ? { runtimeName: optionalString(ownDataValue(input, "runtimeName")) }
      : {}),
    source: source as ToolExecutionSource,
    status: status as ToolExecutionStatus,
    observedAt,
    ...(typeof rawDuration === "number"
      ? { durationMs: rawDuration }
      : {}),
  });

  return Object.freeze({
    accepted: true,
    event,
  });
}

function identityKey(event: ToolExecutionObservation): string {
  return event.toolId
    ? `tool:${event.toolId}`
    : `name:${event.namespacedName}`;
}

function compareTimestamp(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

/**
 * Aggregate already-observed execution metadata without retaining raw call data.
 * Duplicate event IDs are ignored so replayed telemetry batches do not inflate
 * observed execution counts.
 */
export function aggregateToolExecutions(
  inputs: readonly unknown[],
): ToolExecutionAggregate {
  const accepted: ToolExecutionObservation[] = [];
  let rejectedEventCount = 0;
  let duplicateEventCount = 0;
  const seenEventIds = new Set<string>();

  for (const input of inputs) {
    const result = observeToolExecution(input);
    if (!result.accepted) {
      rejectedEventCount += 1;
      continue;
    }

    if (result.event.eventId) {
      if (seenEventIds.has(result.event.eventId)) {
        duplicateEventCount += 1;
        continue;
      }
      seenEventIds.add(result.event.eventId);
    }

    accepted.push(result.event);
  }

  const groups = new Map<string, ToolExecutionObservation[]>();
  for (const event of accepted) {
    const key = identityKey(event);
    const existing = groups.get(key);
    if (existing) {
      existing.push(event);
    } else {
      groups.set(key, [event]);
    }
  }

  const summaries: ToolExecutionSummary[] = [];

  for (const [key, events] of groups.entries()) {
    const ordered = [...events].sort((left, right) =>
      compareTimestamp(left.observedAt, right.observedAt),
    );
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const durations = ordered
      .map(event => event.durationMs)
      .filter((value): value is number => typeof value === "number");
    const totalDurationMs = durations.reduce((sum, value) => sum + value, 0);
    const sources = Object.freeze([
      ...new Set(ordered.map(event => event.source)),
    ]);

    summaries.push(Object.freeze({
      identityKey: key,
      ...(last.toolId ? { toolId: last.toolId } : {}),
      ...(last.namespacedName ? { namespacedName: last.namespacedName } : {}),
      ...(last.canonicalName ? { canonicalName: last.canonicalName } : {}),
      ...(last.framework ? { framework: last.framework } : {}),
      ...(last.runtimeName ? { runtimeName: last.runtimeName } : {}),
      callCount: ordered.length,
      succeededCount: ordered.filter(event => event.status === "SUCCEEDED").length,
      failedCount: ordered.filter(event => event.status === "FAILED").length,
      unknownCount: ordered.filter(event => event.status === "UNKNOWN").length,
      firstObservedAt: first.observedAt,
      lastObservedAt: last.observedAt,
      latestStatus: last.status,
      ...(durations.length > 0
        ? {
            totalDurationMs,
            averageDurationMs: totalDurationMs / durations.length,
          }
        : {}),
      sources,
    }));
  }

  summaries.sort((left, right) =>
    left.identityKey.localeCompare(right.identityKey),
  );

  return Object.freeze({
    summaries: Object.freeze(summaries),
    acceptedEventCount: accepted.length,
    rejectedEventCount,
    duplicateEventCount,
  });
}

function summaryMatchesTool(
  tool: ExecutionPromotableTool,
  summary: ToolExecutionSummary,
): boolean {
  if (summary.toolId) {
    return summary.toolId === tool.toolId;
  }

  return Boolean(
    summary.namespacedName &&
    summary.namespacedName === tool.namespacedName,
  );
}

/**
 * Promote a discovered tool to EXECUTED evidence only after exact identity
 * correlation. Canonical/display names alone are never sufficient because
 * same-named tools may exist in different agents, runtimes or servers.
 */
export function promoteToolExecution<
  T extends ExecutionPromotableTool,
>(
  tool: T,
  summary: ToolExecutionSummary,
): ExecutedToolObservation<T> | undefined {
  if (!summaryMatchesTool(tool, summary)) {
    return undefined;
  }

  const visibility = Object.freeze({
    ...tool.visibility,
    executed: true as const,
  });

  const once = assessToolImportance({
    name: tool.canonicalName,
    description: tool.description,
    sourceCategory: tool.toolType,
    evidence: "EXECUTED",
    qualification: tool.once.qualification,
    protection: tool.once.protection,
    readOnlyHint:
      tool.once.effectClass === "READ_ONLY"
        ? true
        : undefined,
  });

  return Object.freeze({
    ...tool,
    evidence: Object.freeze({
      level: "EXECUTED" as const,
      source: `execution:${summary.sources.join(",")}`,
    }),
    visibility,
    execution: summary,
    once,
  }) as ExecutedToolObservation<T>;
}

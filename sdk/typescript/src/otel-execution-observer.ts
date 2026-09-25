import {
  executionToolFingerprint,
  observeToolExecution,
  type ExecutionPromotableTool,
  type ToolExecutionObservation,
} from "./execution-observation.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function ownDataValue(value: unknown, key: string): unknown {
  const record = asRecord(value);
  if (!record) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function ownString(value: unknown, key: string): string | undefined {
  const raw = ownDataValue(value, key);
  return typeof raw === "string" && raw.trim() !== ""
    ? raw
    : undefined;
}

function attributesOf(span: unknown): JsonRecord | undefined {
  const raw = ownDataValue(span, "attributes");
  return asRecord(raw);
}

function attrString(attributes: JsonRecord | undefined, key: string): string | undefined {
  if (!attributes) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(attributes, key);
  if (!descriptor || !("value" in descriptor)) return undefined;
  return typeof descriptor.value === "string" && descriptor.value.trim() !== ""
    ? descriptor.value
    : undefined;
}

function toolIndex(
  tools: readonly ExecutionPromotableTool[],
): Map<string, ExecutionPromotableTool | null> {
  const map = new Map<string, ExecutionPromotableTool | null>();

  for (const tool of tools) {
    const current = map.get(tool.canonicalName);
    if (current === undefined) {
      map.set(tool.canonicalName, tool);
    } else {
      // A generic OTel span normally identifies the tool by name only. If the
      // caller supplies multiple same-named candidates, fail closed rather
      // than choosing one by order.
      map.set(tool.canonicalName, null);
    }
  }

  return map;
}

function spanStatus(span: unknown, attributes: JsonRecord | undefined):
  "SUCCEEDED" | "FAILED" | "UNKNOWN" {
  const errorType = attrString(attributes, "error.type");
  if (errorType) return "FAILED";

  const status = ownDataValue(span, "status");
  const statusRecord = asRecord(status);
  const rawCode = statusRecord
    ? ownDataValue(statusRecord, "code")
    : status;

  if (rawCode === 2 || rawCode === "ERROR") return "FAILED";
  if (rawCode === 1 || rawCode === "OK") return "SUCCEEDED";
  return "UNKNOWN";
}

function spanEventId(
  span: unknown,
  attributes: JsonRecord | undefined,
): string | undefined {
  const traceId = ownString(span, "traceId");
  const spanId = ownString(span, "spanId");
  if (traceId && spanId) {
    return `otel-span:${traceId}:${spanId}`;
  }

  const callId = attrString(attributes, "gen_ai.tool.call.id");
  return callId ? `otel-tool-call:${callId}` : undefined;
}

function durationMs(span: unknown): number | undefined {
  const raw = ownDataValue(span, "durationMs");
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? raw
    : undefined;
}

/**
 * Ingest already-materialized OpenTelemetry GenAI tool-execution spans.
 *
 * Only spans with `gen_ai.operation.name=execute_tool` are considered. The
 * implementation deliberately reads a tiny allowlist of low-risk attributes
 * and never reads `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`,
 * exception messages/stacks, prompts, results or other content-bearing fields.
 *
 * Generic OTel tool spans commonly identify tools by name. Therefore a name
 * must resolve to exactly one caller-supplied Tool Graph observation; duplicate
 * names fail closed instead of being correlated by array order.
 */
export function observeOtelGenAiToolExecutions(
  spans: readonly unknown[],
  tools: readonly ExecutionPromotableTool[],
): readonly ToolExecutionObservation[] {
  const byName = toolIndex(tools);
  const events: ToolExecutionObservation[] = [];

  for (const span of spans) {
    const attributes = attributesOf(span);
    if (attrString(attributes, "gen_ai.operation.name") !== "execute_tool") {
      continue;
    }

    const toolName = attrString(attributes, "gen_ai.tool.name");
    if (!toolName) continue;

    const tool = byName.get(toolName);
    if (!tool) continue;

    const framework =
      attrString(attributes, "gen_ai.provider.name") ??
      ownString(span, "instrumentationScopeName") ??
      undefined;

    const eventId = spanEventId(span, attributes);
    const duration = durationMs(span);
    const observedAt = ownString(span, "endTime") ?? new Date().toISOString();

    const observed = observeToolExecution({
      ...(eventId ? { eventId } : {}),
      toolId: tool.toolId,
      namespacedName: tool.namespacedName,
      descriptorFingerprint: executionToolFingerprint(tool),
      canonicalName: tool.canonicalName,
      ...(framework ? { framework } : {}),
      source: "otel",
      status: spanStatus(span, attributes),
      observedAt,
      ...(duration !== undefined ? { durationMs: duration } : {}),
    });

    if (observed.accepted) {
      events.push(observed.event);
    }
  }

  return Object.freeze(events);
}

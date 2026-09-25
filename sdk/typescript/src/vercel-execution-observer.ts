import {
  executionToolFingerprint,
  observeToolExecution,
  type ToolExecutionObservation,
} from "./execution-observation.js";
import type {
  RuntimeToolObservation,
  VercelAiSdkModelVisibleToolSnapshot,
} from "./runtime-tool-discovery.js";

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

function arrayData(value: unknown, key: string): unknown[] {
  const raw = ownDataValue(value, key);
  return Array.isArray(raw) ? raw : [];
}

function toolMap(
  snapshot: VercelAiSdkModelVisibleToolSnapshot,
): Map<string, RuntimeToolObservation | null> {
  const map = new Map<string, RuntimeToolObservation | null>();

  for (const tool of snapshot.tools) {
    const current = map.get(tool.canonicalName);
    if (current === undefined) {
      map.set(tool.canonicalName, tool);
    } else {
      // Fail closed if a malformed/custom snapshot contains duplicate names.
      map.set(tool.canonicalName, null);
    }
  }

  return map;
}

function statusFromResult(result: unknown): "SUCCEEDED" | "FAILED" | "UNKNOWN" {
  const isError = ownDataValue(result, "isError");
  if (isError === true) return "FAILED";
  if (isError === false) return "SUCCEEDED";
  return "UNKNOWN";
}

/**
 * Convert an already-emitted Vercel AI SDK step result into Once EXECUTED
 * observations. This helper never calls a model, provider, tool or callback.
 *
 * Only entries present in `toolResults` establish execution evidence. A
 * `toolCalls` entry without a result is model intent, not proof of execution.
 * Tool arguments and tool results are deliberately ignored.
 */
export function observeVercelAiSdkStepExecutions(
  stepResult: unknown,
  visibleSnapshot: VercelAiSdkModelVisibleToolSnapshot,
): readonly ToolExecutionObservation[] {
  const visible = toolMap(visibleSnapshot);
  const calls = arrayData(stepResult, "toolCalls");
  const results = arrayData(stepResult, "toolResults");
  const callNameById = new Map<string, string>();

  for (const call of calls) {
    const toolCallId = ownString(call, "toolCallId");
    const toolName = ownString(call, "toolName");
    if (toolCallId && toolName) {
      callNameById.set(toolCallId, toolName);
    }
  }

  const observations: ToolExecutionObservation[] = [];
  const now = new Date().toISOString();

  for (const result of results) {
    const toolCallId = ownString(result, "toolCallId");
    const explicitName = ownString(result, "toolName");
    const toolName = explicitName ?? (toolCallId ? callNameById.get(toolCallId) : undefined);
    if (!toolName) continue;

    const tool = visible.get(toolName);
    if (!tool) continue;

    const observed = observeToolExecution({
      ...(toolCallId ? { eventId: `vercel-tool-call:${toolCallId}` } : {}),
      toolId: tool.toolId,
      namespacedName: tool.namespacedName,
      descriptorFingerprint: executionToolFingerprint(tool),
      canonicalName: tool.canonicalName,
      framework: "vercel-ai-sdk",
      runtimeName: visibleSnapshot.runtimeName,
      source: "framework_callback",
      status: statusFromResult(result),
      observedAt: now,
    });

    if (observed.accepted) {
      observations.push(observed.event);
    }
  }

  return Object.freeze(observations);
}

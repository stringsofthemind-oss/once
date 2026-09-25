import {
  executionToolFingerprint,
  observeToolExecution,
  type ToolExecutionObservation,
} from "./execution-observation.js";
import type {
  LangChainModelVisibleToolSnapshot,
  LangChainRuntimeToolObservation,
} from "./langchain-runtime-discovery.js";

type JsonRecord = Record<string, unknown>;

type PendingToolRun = {
  tool: LangChainRuntimeToolObservation;
  startedAtMs: number;
  toolCallId?: string;
};

export type LangChainExecutionObserver = Readonly<{
  name: "once-execution-observer";
  handleToolStart: (...args: unknown[]) => void;
  handleToolEnd: (...args: unknown[]) => void;
  handleToolError: (...args: unknown[]) => void;
  events: () => readonly ToolExecutionObservation[];
  drain: () => readonly ToolExecutionObservation[];
  pendingCount: () => number;
}>;

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

function optionalArgString(args: readonly unknown[], index: number): string | undefined {
  const value = args[index];
  return typeof value === "string" && value.trim() !== ""
    ? value
    : undefined;
}

function toolByName(
  snapshot: LangChainModelVisibleToolSnapshot,
): Map<string, LangChainRuntimeToolObservation | null> {
  const map = new Map<string, LangChainRuntimeToolObservation | null>();
  for (const tool of snapshot.tools) {
    if (!map.has(tool.canonicalName)) {
      map.set(tool.canonicalName, tool);
    } else {
      map.set(tool.canonicalName, null);
    }
  }
  return map;
}

function serializedToolName(serialized: unknown): string | undefined {
  const direct = ownString(serialized, "name");
  if (direct) return direct;

  const id = ownDataValue(serialized, "id");
  if (!Array.isArray(id) || id.length === 0) return undefined;
  const last = id[id.length - 1];
  return typeof last === "string" && last.trim() !== ""
    ? last
    : undefined;
}

/**
 * Create a dependency-free object compatible with LangChain callback handler
 * methods for tool execution observation.
 *
 * The observer never invokes a tool and never retains input, output, errors,
 * tags, metadata or parent run state. A matching handleToolStart establishes
 * exact tool identity; handleToolEnd/handleToolError close that run as
 * SUCCEEDED/FAILED respectively.
 */
export function createLangChainExecutionObserver(
  visibleSnapshot: LangChainModelVisibleToolSnapshot,
): LangChainExecutionObserver {
  const byName = toolByName(visibleSnapshot);
  const pending = new Map<string, PendingToolRun>();
  const collected: ToolExecutionObservation[] = [];

  const handleToolStart = (...args: unknown[]): void => {
    // Current CallbackHandlerMethods shape:
    // (serializedTool, input, runId, parentRunId?, tags?, metadata?, runName?, toolCallId?)
    const runId = optionalArgString(args, 2);
    if (!runId) return;

    const serialized = args[0];
    const runName = optionalArgString(args, 6);
    const name = runName ?? serializedToolName(serialized);
    if (!name) return;

    const tool = byName.get(name);
    if (!tool) return;

    const toolCallId = optionalArgString(args, 7);
    pending.set(runId, {
      tool,
      startedAtMs: Date.now(),
      ...(toolCallId ? { toolCallId } : {}),
    });
  };

  const finish = (
    status: "SUCCEEDED" | "FAILED",
    args: readonly unknown[],
  ): void => {
    // handleToolEnd(output, runId, ...)
    // handleToolError(error, runId, ...)
    const runId = optionalArgString(args, 1);
    if (!runId) return;

    const started = pending.get(runId);
    if (!started) return;
    pending.delete(runId);

    const now = Date.now();
    const observed = observeToolExecution({
      eventId: `langchain-tool-run:${runId}`,
      toolId: started.tool.toolId,
      namespacedName: started.tool.namespacedName,
      descriptorFingerprint: executionToolFingerprint(started.tool),
      canonicalName: started.tool.canonicalName,
      framework: "langchain",
      runtimeName: visibleSnapshot.runtimeName,
      source: "framework_callback",
      status,
      observedAt: new Date(now).toISOString(),
      durationMs: Math.max(0, now - started.startedAtMs),
    });

    if (observed.accepted) {
      collected.push(observed.event);
    }
  };

  return Object.freeze({
    name: "once-execution-observer" as const,
    handleToolStart,
    handleToolEnd: (...args: unknown[]) => finish("SUCCEEDED", args),
    handleToolError: (...args: unknown[]) => finish("FAILED", args),
    events: () => Object.freeze([...collected]),
    drain: () => {
      const drained = Object.freeze([...collected]);
      collected.length = 0;
      return drained;
    },
    pendingCount: () => pending.size,
  });
}

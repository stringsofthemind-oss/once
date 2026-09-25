import {
  executionToolFingerprint,
  observeToolExecution,
  type ToolExecutionObservation,
} from "./execution-observation.js";
import {
  discoverOpenAIAgentRuntime,
  type OpenAIAgentRuntimeSnapshot,
  type RuntimeToolObservation,
} from "./runtime-tool-discovery.js";

type JsonRecord = Record<string, unknown>;

type PendingCall = {
  tool: RuntimeToolObservation;
  startedAtMs: number;
  callId?: string;
};

export type OpenAIAgentsExecutionObserver = Readonly<{
  snapshot: OpenAIAgentRuntimeSnapshot;
  onToolStart: (...args: unknown[]) => void;
  onToolEnd: (...args: unknown[]) => void;
  events: () => readonly ToolExecutionObservation[];
  drain: () => readonly ToolExecutionObservation[];
  pendingCount: () => number;
}>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function ownDataValue(
  value: unknown,
  key: string,
): unknown {
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

function agentTools(agent: unknown): unknown[] {
  const tools = ownDataValue(agent, "tools");
  return Array.isArray(tools) ? tools : [];
}

function safeAgentSnapshot(agent: unknown): OpenAIAgentRuntimeSnapshot {
  const name = ownString(agent, "name");
  const tools = agentTools(agent);
  const mcpServers = ownDataValue(agent, "mcpServers");
  const mcpConfig = ownDataValue(agent, "mcpConfig");

  return discoverOpenAIAgentRuntime({
    ...(name ? { name } : {}),
    tools,
    ...(Array.isArray(mcpServers) ? { mcpServers } : {}),
    ...(mcpConfig && typeof mcpConfig === "object" ? { mcpConfig } : {}),
  });
}

function findToolArgument(
  args: readonly unknown[],
  byObject: WeakMap<object, RuntimeToolObservation>,
): { raw: object; observation: RuntimeToolObservation } | undefined {
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const observation = byObject.get(arg as object);
    if (observation) {
      return {
        raw: arg as object,
        observation,
      };
    }
  }
  return undefined;
}

function callIdFromArgs(args: readonly unknown[]): string | undefined {
  for (let index = args.length - 1; index >= 0; index--) {
    const details = args[index];
    const toolCall = ownDataValue(details, "toolCall");
    const callId = ownString(toolCall, "callId");
    if (callId) return callId;
  }
  return undefined;
}

/**
 * Build dependency-free OpenAI Agents lifecycle handlers for execution evidence.
 *
 * The returned callbacks are meant to be registered with either an Agent or a
 * Runner `agent_tool_start` / `agent_tool_end` hook. This helper never registers
 * itself, never invokes a tool, and never reads tool arguments/results/context.
 *
 * `agent_tool_end` is proof that the tool lifecycle reached the end hook, so it
 * can establish EXECUTED evidence. The v1 adapter records outcome as UNKNOWN:
 * framework end hooks alone are not treated as authoritative proof that an
 * external side effect succeeded.
 */
export function createOpenAIAgentsExecutionObserver(
  agent: unknown,
): OpenAIAgentsExecutionObserver {
  const rawTools = agentTools(agent);
  const snapshot = safeAgentSnapshot(agent);
  const byObject = new WeakMap<object, RuntimeToolObservation>();

  for (const observation of snapshot.tools) {
    const index = observation.origin.index;
    const raw = rawTools[index];
    if (raw && typeof raw === "object") {
      byObject.set(raw as object, observation);
    }
  }

  const pendingByCallId = new Map<string, PendingCall>();
  const pendingWithoutCallId = new WeakMap<object, PendingCall[]>();
  const collected: ToolExecutionObservation[] = [];
  let pendingWithoutIdCount = 0;

  const onToolStart = (...args: unknown[]): void => {
    const match = findToolArgument(args, byObject);
    if (!match) return;

    const callId = callIdFromArgs(args);
    const pending: PendingCall = {
      tool: match.observation,
      startedAtMs: Date.now(),
      ...(callId ? { callId } : {}),
    };

    if (callId) {
      pendingByCallId.set(callId, pending);
      return;
    }

    const queue = pendingWithoutCallId.get(match.raw) ?? [];
    queue.push(pending);
    pendingWithoutCallId.set(match.raw, queue);
    pendingWithoutIdCount += 1;
  };

  const onToolEnd = (...args: unknown[]): void => {
    const match = findToolArgument(args, byObject);
    if (!match) return;

    const callId = callIdFromArgs(args);
    let pending: PendingCall | undefined;

    if (callId) {
      pending = pendingByCallId.get(callId);
      pendingByCallId.delete(callId);
    } else {
      const queue = pendingWithoutCallId.get(match.raw);
      pending = queue?.shift();
      if (pending) pendingWithoutIdCount -= 1;
      if (queue && queue.length === 0) {
        pendingWithoutCallId.delete(match.raw);
      }
    }

    const tool = pending?.tool ?? match.observation;
    const now = Date.now();
    const durationMs = pending
      ? Math.max(0, now - pending.startedAtMs)
      : undefined;

    const result = observeToolExecution({
      ...(callId ? { eventId: `openai-tool-call:${callId}` } : {}),
      toolId: tool.toolId,
      namespacedName: tool.namespacedName,
      descriptorFingerprint: executionToolFingerprint(tool),
      canonicalName: tool.canonicalName,
      framework: tool.framework,
      runtimeName: tool.origin.agentName,
      source: "framework_callback",
      status: "UNKNOWN",
      observedAt: new Date(now).toISOString(),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });

    if (result.accepted) {
      collected.push(result.event);
    }
  };

  return Object.freeze({
    snapshot,
    onToolStart,
    onToolEnd,
    events: () => Object.freeze([...collected]),
    drain: () => {
      const drained = Object.freeze([...collected]);
      collected.length = 0;
      return drained;
    },
    pendingCount: () => pendingByCallId.size + pendingWithoutIdCount,
  });
}

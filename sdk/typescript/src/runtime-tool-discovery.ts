import { createHash } from "node:crypto";

import {
  assessToolImportance,
  type ToolEvidenceLevel,
  type ToolImportanceAssessment,
} from "./tool-importance.js";

type JsonRecord = Record<string, unknown>;

export type RuntimeToolFramework =
  | "openai-agents"
  | "openai-responses";

export type RuntimeToolObservation = {
  toolId: string;
  namespacedName: string;
  canonicalName: string;
  displayName: string;
  description: string;
  toolType: string;
  framework: RuntimeToolFramework;
  origin: {
    kind: "runtime";
    source: "agent.tools" | "responses.tools";
    agentName?: string;
    index: number;
  };
  evidence: {
    level: "RUNTIME_REGISTERED" | "MODEL_VISIBLE";
    source: string;
  };
  visibility: {
    configured: boolean;
    runtimeRegistered: boolean;
    modelVisible: boolean;
    executed: false;
  };
  inputSchema?: unknown;
  safeMetadata?: {
    serverLabel?: string;
    namespace?: string;
    deferLoading?: boolean;
  };
  once: ToolImportanceAssessment;
};

export type OpenAIAgentRuntimeSnapshot = {
  framework: "openai-agents";
  agentName?: string;
  registeredToolCount: number;
  configuredMcpServerCount: number;
  includeServerInToolNames?: boolean;
  tools: RuntimeToolObservation[];
  externalCallsMade: false;
  toolInvocationsMade: false;
  secretValuesRetained: false;
};

export type OpenAIResponsesToolSnapshot = {
  framework: "openai-responses";
  modelVisibleToolCount: number;
  tools: RuntimeToolObservation[];
  externalCallsMade: false;
  toolInvocationsMade: false;
  secretValuesRetained: false;
};

export type MergedRuntimeToolSnapshot = {
  tools: RuntimeToolObservation[];
};

function asRecord(value: unknown): JsonRecord | undefined {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value as JsonRecord;
  }

  return undefined;
}

function stableId(prefix: string, value: unknown): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
  return `${prefix}:${hash}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : undefined;
}

function toolType(tool: JsonRecord): string {
  return stringValue(tool.type) ?? "unknown";
}

function toolName(tool: JsonRecord, type: string, index: number): string {
  const direct = stringValue(tool.name);
  if (direct) return direct;

  const functionRecord = asRecord(tool.function);
  const nested = stringValue(functionRecord?.name);
  if (nested) return nested;

  const serverLabel =
    stringValue(tool.server_label) ??
    stringValue(tool.serverLabel);
  if (serverLabel && (type === "mcp" || type.includes("mcp"))) {
    return `mcp:${serverLabel}`;
  }

  return `${type || "tool"}:${index}`;
}

function toolDescription(tool: JsonRecord): string {
  const direct = stringValue(tool.description);
  if (direct) return direct;

  const functionRecord = asRecord(tool.function);
  return stringValue(functionRecord?.description) ?? "";
}

function toolSchema(tool: JsonRecord): unknown {
  if (tool.parameters !== undefined) return tool.parameters;
  if (tool.inputSchema !== undefined) return tool.inputSchema;

  const functionRecord = asRecord(tool.function);
  if (functionRecord?.parameters !== undefined) {
    return functionRecord.parameters;
  }

  return undefined;
}

function safeMetadata(tool: JsonRecord): RuntimeToolObservation["safeMetadata"] {
  const serverLabel =
    stringValue(tool.server_label) ??
    stringValue(tool.serverLabel);
  const namespace = stringValue(tool.namespace);
  const deferLoading =
    typeof tool.defer_loading === "boolean"
      ? tool.defer_loading
      : typeof tool.deferLoading === "boolean"
        ? tool.deferLoading
        : undefined;

  const metadata = {
    ...(serverLabel ? { serverLabel } : {}),
    ...(namespace ? { namespace } : {}),
    ...(deferLoading !== undefined ? { deferLoading } : {}),
  };

  return Object.keys(metadata).length > 0
    ? metadata
    : undefined;
}

function readOnlyHintForType(type: string): boolean | undefined {
  switch (type) {
    case "web_search":
    case "web_search_preview":
    case "file_search":
      return true;
    default:
      return undefined;
  }
}

function observation(
  tool: unknown,
  framework: RuntimeToolFramework,
  evidence: "RUNTIME_REGISTERED" | "MODEL_VISIBLE",
  source: "agent.tools" | "responses.tools",
  index: number,
  agentName?: string,
): RuntimeToolObservation | undefined {
  const record = asRecord(tool);
  if (!record) return undefined;

  const type = toolType(record);
  const name = toolName(record, type, index);
  const description = toolDescription(record);
  const schema = toolSchema(record);
  const metadata = safeMetadata(record);
  const namespace =
    framework === "openai-agents"
      ? `openai-agents/${agentName ?? "agent"}`
      : "openai-responses/model";
  const namespacedName = `${namespace}/${name}`;

  return {
    toolId: stableId("tool", {
      framework,
      namespace,
      name,
      type,
    }),
    namespacedName,
    canonicalName: name,
    displayName: name,
    description,
    toolType: type,
    framework,
    origin: {
      kind: "runtime",
      source,
      ...(agentName ? { agentName } : {}),
      index,
    },
    evidence: {
      level: evidence,
      source:
        framework === "openai-agents"
          ? `openai-agents:${agentName ?? "agent"}`
          : "openai-responses:tools",
    },
    visibility: {
      configured: true,
      runtimeRegistered:
        evidence === "RUNTIME_REGISTERED" ||
        evidence === "MODEL_VISIBLE",
      modelVisible: evidence === "MODEL_VISIBLE",
      executed: false,
    },
    ...(schema !== undefined ? { inputSchema: schema } : {}),
    ...(metadata ? { safeMetadata: metadata } : {}),
    once: assessToolImportance({
      name,
      description,
      sourceCategory: type,
      evidence,
      readOnlyHint: readOnlyHintForType(type),
    }),
  };
}

export function discoverOpenAIAgentRuntime(
  agent: unknown,
): OpenAIAgentRuntimeSnapshot {
  const record = asRecord(agent);
  const agentName = stringValue(record?.name);
  const rawTools = Array.isArray(record?.tools)
    ? record.tools
    : [];
  const mcpServers = Array.isArray(record?.mcpServers)
    ? record.mcpServers
    : Array.isArray(record?.mcp_servers)
      ? record.mcp_servers
      : [];
  const mcpConfig = asRecord(record?.mcpConfig);
  const includeServerInToolNames =
    typeof mcpConfig?.includeServerInToolNames === "boolean"
      ? mcpConfig.includeServerInToolNames
      : undefined;

  const tools = rawTools
    .map((tool, index) =>
      observation(
        tool,
        "openai-agents",
        "RUNTIME_REGISTERED",
        "agent.tools",
        index,
        agentName,
      ),
    )
    .filter((tool): tool is RuntimeToolObservation => Boolean(tool));

  return {
    framework: "openai-agents",
    ...(agentName ? { agentName } : {}),
    registeredToolCount: tools.length,
    configuredMcpServerCount: mcpServers.length,
    ...(includeServerInToolNames !== undefined
      ? { includeServerInToolNames }
      : {}),
    tools,
    externalCallsMade: false,
    toolInvocationsMade: false,
    secretValuesRetained: false,
  };
}

function extractResponsesTools(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  const record = asRecord(input);
  return Array.isArray(record?.tools) ? record.tools : [];
}

export function discoverOpenAIResponsesModelVisibleTools(
  requestOrTools: unknown,
): OpenAIResponsesToolSnapshot {
  const rawTools = extractResponsesTools(requestOrTools);
  const tools = rawTools
    .map((tool, index) =>
      observation(
        tool,
        "openai-responses",
        "MODEL_VISIBLE",
        "responses.tools",
        index,
      ),
    )
    .filter((tool): tool is RuntimeToolObservation => Boolean(tool));

  return {
    framework: "openai-responses",
    modelVisibleToolCount: tools.length,
    tools,
    externalCallsMade: false,
    toolInvocationsMade: false,
    secretValuesRetained: false,
  };
}

const evidenceRank: Record<ToolEvidenceLevel, number> = {
  REGISTRY_CANDIDATE: 0,
  SOURCE_DISCOVERED: 1,
  HOST_CONFIGURED: 2,
  SERVER_AUTHORITATIVE: 3,
  RUNTIME_REGISTERED: 4,
  MODEL_VISIBLE: 5,
  EXECUTED: 6,
};

export function mergeRuntimeToolEvidence(
  ...snapshots: Array<
    OpenAIAgentRuntimeSnapshot |
    OpenAIResponsesToolSnapshot |
    MergedRuntimeToolSnapshot
  >
): MergedRuntimeToolSnapshot {
  const merged = new Map<string, RuntimeToolObservation>();

  for (const snapshot of snapshots) {
    for (const tool of snapshot.tools) {
      const key = `${tool.canonicalName}\u0000${tool.toolType}`;
      const current = merged.get(key);

      if (
        !current ||
        evidenceRank[tool.evidence.level] >
          evidenceRank[current.evidence.level]
      ) {
        merged.set(key, tool);
      }
    }
  }

  return {
    tools: [...merged.values()].sort((left, right) =>
      left.canonicalName.localeCompare(right.canonicalName) ||
      left.toolType.localeCompare(right.toolType),
    ),
  };
}

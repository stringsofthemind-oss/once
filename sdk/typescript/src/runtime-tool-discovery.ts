import { createHash } from "node:crypto";

import {
  assessToolImportance,
  type ToolEvidenceLevel,
  type ToolImportanceAssessment,
} from "./tool-importance.js";

type JsonRecord = Record<string, unknown>;

export type RuntimeToolFramework =
  | "openai-agents"
  | "openai-responses"
  | "vercel-ai-sdk";

export type RuntimeToolSource =
  | "agent.tools"
  | "responses.tools"
  | "vercel.toolset"
  | "vercel.generation.tools";

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
    source: RuntimeToolSource;
    agentName?: string;
    runtimeName?: string;
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
    autoExecutable?: boolean;
    schemaOpaque?: boolean;
    providerDefined?: boolean;
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

export type VercelAiSdkRegisteredToolSnapshot = {
  framework: "vercel-ai-sdk";
  runtimeName?: string;
  registeredToolCount: number;
  tools: RuntimeToolObservation[];
  externalCallsMade: false;
  toolInvocationsMade: false;
  secretValuesRetained: false;
};

export type VercelAiSdkModelVisibleToolSnapshot = {
  framework: "vercel-ai-sdk";
  runtimeName?: string;
  modelVisibleToolCount: number;
  activeToolFilterApplied: boolean;
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

function ownDataValue(
  record: JsonRecord | undefined,
  key: string,
): unknown {
  if (!record) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor
    ? descriptor.value
    : undefined;
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
  framework: "openai-agents" | "openai-responses",
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
      runtimeRegistered: true,
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

const secretNamePattern =
  /(?:^|[_-])(authorization|api[_-]?key|token|password|passwd|secret|credential|cookie)(?:$|[_-])/i;

const secretValueKeywords = new Set([
  "default",
  "example",
  "examples",
  "const",
]);

function safeJsonData(
  value: unknown,
  depth = 0,
  seen: Set<object> = new Set(),
  secretContext = false,
): unknown | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") {
    return secretContext ? "<redacted>" : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? (secretContext ? "<redacted>" : value)
      : undefined;
  }
  if (typeof value !== "object" || depth > 12) return undefined;

  const objectValue = value as object;
  if (seen.has(objectValue)) return undefined;
  seen.add(objectValue);

  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) return undefined;
        const item = safeJsonData(
          descriptor.value,
          depth + 1,
          seen,
          secretContext,
        );
        if (item === undefined) return undefined;
        output.push(item);
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }

    const output: JsonRecord = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) continue;
      if (descriptor.value === undefined) continue;

      const keySecret = secretContext || secretNamePattern.test(key);
      if (keySecret && secretValueKeywords.has(key.toLowerCase())) {
        output[key] = "<redacted>";
        continue;
      }

      const child = safeJsonData(
        descriptor.value,
        depth + 1,
        seen,
        keySecret,
      );
      if (child !== undefined) output[key] = child;
    }

    return output;
  } finally {
    seen.delete(objectValue);
  }
}

function vercelToolEntries(toolSet: unknown): Array<[string, JsonRecord]> {
  const record = asRecord(toolSet);
  if (!record) return [];

  const descriptors = Object.getOwnPropertyDescriptors(record);
  const entries: Array<[string, JsonRecord]> = [];

  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) continue;
    const tool = asRecord(descriptor.value);
    if (tool) entries.push([name, tool]);
  }

  return entries;
}

function vercelToolSetFromInput(input: unknown): JsonRecord | undefined {
  const record = asRecord(input);
  if (!record) return undefined;

  const tools = asRecord(ownDataValue(record, "tools"));
  return tools ?? record;
}

function vercelActiveTools(input: unknown): Set<string> | undefined {
  const record = asRecord(input);
  if (!record || !asRecord(ownDataValue(record, "tools"))) return undefined;

  const candidates = [
    ownDataValue(record, "activeTools"),
    ownDataValue(record, "experimental_activeTools"),
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const names = candidate.filter(
      (value): value is string => typeof value === "string",
    );
    return new Set(names);
  }

  return undefined;
}

function vercelToolObservation(
  name: string,
  tool: JsonRecord,
  evidence: "RUNTIME_REGISTERED" | "MODEL_VISIBLE",
  source: "vercel.toolset" | "vercel.generation.tools",
  index: number,
  runtimeName?: string,
): RuntimeToolObservation {
  const explicitType = stringValue(ownDataValue(tool, "type"));
  const type = explicitType ?? "function";
  const description =
    stringValue(ownDataValue(tool, "description")) ?? "";
  const rawSchema =
    ownDataValue(tool, "inputSchema") ??
    ownDataValue(tool, "parameters");
  const schema = safeJsonData(rawSchema);
  const schemaOpaque = rawSchema !== undefined && schema === undefined;
  const autoExecutable =
    typeof ownDataValue(tool, "execute") === "function";
  const providerDefined =
    Boolean(explicitType && explicitType.toLowerCase().includes("provider"));
  const namespace = `vercel-ai-sdk/${runtimeName ?? "runtime"}`;

  const metadata: NonNullable<RuntimeToolObservation["safeMetadata"]> = {
    autoExecutable,
    ...(schemaOpaque ? { schemaOpaque: true } : {}),
    ...(providerDefined ? { providerDefined: true } : {}),
  };

  return {
    toolId: stableId("tool", {
      framework: "vercel-ai-sdk",
      namespace,
      name,
      type,
    }),
    namespacedName: `${namespace}/${name}`,
    canonicalName: name,
    displayName: name,
    description,
    toolType: type,
    framework: "vercel-ai-sdk",
    origin: {
      kind: "runtime",
      source,
      ...(runtimeName ? { runtimeName } : {}),
      index,
    },
    evidence: {
      level: evidence,
      source: `${namespace}:${source}`,
    },
    visibility: {
      configured: true,
      runtimeRegistered: true,
      modelVisible: evidence === "MODEL_VISIBLE",
      executed: false,
    },
    ...(schema !== undefined ? { inputSchema: schema } : {}),
    safeMetadata: metadata,
    once: assessToolImportance({
      name,
      description,
      sourceCategory: type,
      evidence,
      readOnlyHint:
        /(?:^|[_-])(?:web[_-]?search|file[_-]?search)(?:$|[_-])/i.test(name)
          ? true
          : undefined,
    }),
  };
}

export function discoverVercelAiSdkRegisteredTools(
  toolSetOrRequest: unknown,
  runtimeName?: string,
): VercelAiSdkRegisteredToolSnapshot {
  const toolSet = vercelToolSetFromInput(toolSetOrRequest);
  const tools = vercelToolEntries(toolSet)
    .map(([name, tool], index) =>
      vercelToolObservation(
        name,
        tool,
        "RUNTIME_REGISTERED",
        "vercel.toolset",
        index,
        runtimeName,
      ),
    );

  return {
    framework: "vercel-ai-sdk",
    ...(runtimeName ? { runtimeName } : {}),
    registeredToolCount: tools.length,
    tools,
    externalCallsMade: false,
    toolInvocationsMade: false,
    secretValuesRetained: false,
  };
}

export function discoverVercelAiSdkModelVisibleTools(
  requestOrTools: unknown,
  runtimeName?: string,
): VercelAiSdkModelVisibleToolSnapshot {
  const toolSet = vercelToolSetFromInput(requestOrTools);
  const activeTools = vercelActiveTools(requestOrTools);
  const entries = vercelToolEntries(toolSet)
    .filter(([name]) => !activeTools || activeTools.has(name));
  const tools = entries.map(([name, tool], index) =>
    vercelToolObservation(
      name,
      tool,
      "MODEL_VISIBLE",
      "vercel.generation.tools",
      index,
      runtimeName,
    ),
  );

  return {
    framework: "vercel-ai-sdk",
    ...(runtimeName ? { runtimeName } : {}),
    modelVisibleToolCount: tools.length,
    activeToolFilterApplied: Boolean(activeTools),
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

function runtimeCorrelationKey(tool: RuntimeToolObservation): string {
  return JSON.stringify({
    name: tool.canonicalName,
    type: tool.toolType,
    description: tool.description,
    inputSchema: tool.inputSchema,
    safeMetadata: tool.safeMetadata,
  });
}

export function mergeRuntimeToolEvidence(
  ...snapshots: Array<
    OpenAIAgentRuntimeSnapshot |
    OpenAIResponsesToolSnapshot |
    VercelAiSdkRegisteredToolSnapshot |
    VercelAiSdkModelVisibleToolSnapshot |
    MergedRuntimeToolSnapshot
  >
): MergedRuntimeToolSnapshot {
  const merged = new Map<string, RuntimeToolObservation>();

  for (const snapshot of snapshots) {
    for (const tool of snapshot.tools) {
      const key = runtimeCorrelationKey(tool);
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
      left.toolType.localeCompare(right.toolType) ||
      left.description.localeCompare(right.description),
    ),
  };
}

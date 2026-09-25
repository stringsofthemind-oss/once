import { createHash } from "node:crypto";

import {
  assessToolImportance,
  type ToolEvidenceLevel,
  type ToolImportanceAssessment,
} from "./tool-importance.js";

import type {
  RuntimeToolObservation,
} from "./runtime-tool-discovery.js";

type JsonRecord = Record<string, unknown>;

export type LangChainJsToolSource =
  | "langchain.tools"
  | "langchain.bind_tools"
  | "langgraph.tools_by_name";

export type LangChainJsToolObservation = {
  toolId: string;
  namespacedName: string;
  canonicalName: string;
  displayName: string;
  description: string;
  toolType: string;
  framework: "langchain-js";
  origin: {
    kind: "runtime";
    source: LangChainJsToolSource;
    runtimeName?: string;
    index: number;
  };
  evidence: {
    level: "RUNTIME_REGISTERED" | "MODEL_VISIBLE";
    source: string;
  };
  visibility: {
    configured: true;
    runtimeRegistered: true;
    modelVisible: boolean;
    executed: false;
  };
  inputSchema?: unknown;
  safeMetadata?: {
    schemaOpaque?: boolean;
    returnDirect?: boolean;
    serializable?: boolean;
  };
  once: ToolImportanceAssessment;
};

export type LangChainJsContainerKind =
  | "TOOL_ARRAY"
  | "TOOLS_COLLECTION"
  | "LANGGRAPH_REGISTRY"
  | "SINGLE_TOOL"
  | "EMPTY";

export type LangChainJsRegisteredToolSnapshot = {
  framework: "langchain-js";
  runtimeName?: string;
  containerKind: LangChainJsContainerKind;
  registeredToolCount: number;
  tools: LangChainJsToolObservation[];
  externalCallsMade: false;
  toolInvocationsMade: false;
  getterCallsMade: false;
  secretValuesRetained: false;
};

export type LangChainJsModelVisibleToolSnapshot = {
  framework: "langchain-js";
  runtimeName?: string;
  containerKind: LangChainJsContainerKind;
  modelVisibleToolCount: number;
  tools: LangChainJsToolObservation[];
  externalCallsMade: false;
  toolInvocationsMade: false;
  getterCallsMade: false;
  secretValuesRetained: false;
};

export type FrameworkRuntimeToolObservation =
  | RuntimeToolObservation
  | LangChainJsToolObservation;

export type FrameworkRuntimeToolSnapshot = {
  tools: readonly FrameworkRuntimeToolObservation[];
};

export type MergedFrameworkRuntimeToolSnapshot = {
  tools: FrameworkRuntimeToolObservation[];
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

function dataPropertyValue(
  value: unknown,
  key: string,
  maxPrototypeDepth = 8,
): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }

  let current: object | null = value as object;
  let depth = 0;

  while (current && depth <= maxPrototypeDepth) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return "value" in descriptor
        ? descriptor.value
        : undefined;
    }

    current = Object.getPrototypeOf(current);
    depth++;
  }

  return undefined;
}

function ownArrayData(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const output: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }
    output.push(descriptor.value);
  }

  return output;
}

const secretKeyPattern = /(?:authorization|api[_-]?key|apikey|access[_-]?token|accesstoken|refresh[_-]?token|refreshtoken|password|passwd|secret|credential|cookie)/i;

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

  if (typeof value !== "object" || depth > 12) {
    return undefined;
  }

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

      const child = safeJsonData(
        descriptor.value,
        depth + 1,
        seen,
        secretContext || secretKeyPattern.test(key),
      );

      if (child !== undefined) {
        output[key] = child;
      }
    }

    return output;
  } finally {
    seen.delete(objectValue);
  }
}

function nestedFunctionRecord(tool: unknown): JsonRecord | undefined {
  return asRecord(dataPropertyValue(tool, "function"));
}

function langChainToolName(
  tool: unknown,
  fallbackName: string | undefined,
  index: number,
): string {
  const direct = stringValue(dataPropertyValue(tool, "name"));
  if (direct) return direct;

  const nested = nestedFunctionRecord(tool);
  const nestedName = stringValue(dataPropertyValue(nested, "name"));
  if (nestedName) return nestedName;

  return fallbackName ?? `tool:${index}`;
}

function langChainToolDescription(tool: unknown): string {
  const direct = stringValue(dataPropertyValue(tool, "description"));
  if (direct) return direct;

  const nested = nestedFunctionRecord(tool);
  return stringValue(dataPropertyValue(nested, "description")) ?? "";
}

function langChainToolType(tool: unknown): string {
  return stringValue(dataPropertyValue(tool, "type")) ?? "langchain-tool";
}

function langChainRawSchema(tool: unknown): unknown {
  const direct = dataPropertyValue(tool, "schema");
  if (direct !== undefined) return direct;

  const argsSchema =
    dataPropertyValue(tool, "argsSchema") ??
    dataPropertyValue(tool, "args_schema") ??
    dataPropertyValue(tool, "parameters");
  if (argsSchema !== undefined) return argsSchema;

  const nested = nestedFunctionRecord(tool);
  return dataPropertyValue(nested, "parameters");
}

function langChainSafeMetadata(
  tool: unknown,
  rawSchema: unknown,
  schema: unknown,
): LangChainJsToolObservation["safeMetadata"] {
  const returnDirect = dataPropertyValue(tool, "returnDirect");
  const serializable = dataPropertyValue(tool, "lc_serializable");
  const schemaOpaque = rawSchema !== undefined && schema === undefined;

  const metadata = {
    ...(schemaOpaque ? { schemaOpaque: true } : {}),
    ...(typeof returnDirect === "boolean" ? { returnDirect } : {}),
    ...(typeof serializable === "boolean" ? { serializable } : {}),
  };

  return Object.keys(metadata).length > 0
    ? metadata
    : undefined;
}

function readOnlyHint(name: string): boolean | undefined {
  return /^(?:web_search|search_web|file_search)$/i.test(name)
    ? true
    : undefined;
}

type ExtractedTool = {
  tool: unknown;
  fallbackName?: string;
  source: "langchain.tools" | "langgraph.tools_by_name";
};

function registryEntries(value: unknown): ExtractedTool[] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const descriptors = Object.getOwnPropertyDescriptors(record);
  const output: ExtractedTool[] = [];

  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor)) continue;
    if (!descriptor.value || typeof descriptor.value !== "object") continue;
    output.push({
      tool: descriptor.value,
      fallbackName: name,
      source: "langgraph.tools_by_name",
    });
  }

  return output;
}

function extractLangChainTools(input: unknown): {
  kind: LangChainJsContainerKind;
  tools: ExtractedTool[];
} {
  const directArray = ownArrayData(input);
  if (directArray) {
    return {
      kind: "TOOL_ARRAY",
      tools: directArray.map(tool => ({
        tool,
        source: "langchain.tools" as const,
      })),
    };
  }

  const record = asRecord(input);
  if (!record) {
    return { kind: "EMPTY", tools: [] };
  }

  for (const key of ["toolsByName", "tools_by_name"]) {
    const registry = dataPropertyValue(record, key);
    const entries = registryEntries(registry);
    if (entries) {
      return {
        kind: "LANGGRAPH_REGISTRY",
        tools: entries,
      };
    }
  }

  const toolsValue = dataPropertyValue(record, "tools");
  const collection = ownArrayData(toolsValue);
  if (collection) {
    return {
      kind: "TOOLS_COLLECTION",
      tools: collection.map(tool => ({
        tool,
        source: "langchain.tools" as const,
      })),
    };
  }

  if (
    stringValue(dataPropertyValue(record, "name")) ||
    nestedFunctionRecord(record)
  ) {
    return {
      kind: "SINGLE_TOOL",
      tools: [{
        tool: record,
        source: "langchain.tools",
      }],
    };
  }

  return { kind: "EMPTY", tools: [] };
}

function observeLangChainTool(
  extracted: ExtractedTool,
  evidence: "RUNTIME_REGISTERED" | "MODEL_VISIBLE",
  index: number,
  runtimeName?: string,
): LangChainJsToolObservation {
  const name = langChainToolName(
    extracted.tool,
    extracted.fallbackName,
    index,
  );
  const description = langChainToolDescription(extracted.tool);
  const toolType = langChainToolType(extracted.tool);
  const rawSchema = langChainRawSchema(extracted.tool);
  const schema = safeJsonData(rawSchema);
  const metadata = langChainSafeMetadata(
    extracted.tool,
    rawSchema,
    schema,
  );
  const namespace = `langchain-js/${runtimeName ?? "runtime"}`;
  const source: LangChainJsToolSource =
    evidence === "MODEL_VISIBLE"
      ? "langchain.bind_tools"
      : extracted.source;

  return {
    toolId: stableId("tool", {
      framework: "langchain-js",
      namespace,
      name,
      toolType,
    }),
    namespacedName: `${namespace}/${name}`,
    canonicalName: name,
    displayName: name,
    description,
    toolType,
    framework: "langchain-js",
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
    ...(metadata ? { safeMetadata: metadata } : {}),
    once: assessToolImportance({
      name,
      description,
      sourceCategory: toolType,
      evidence,
      readOnlyHint: readOnlyHint(name),
    }),
  };
}

export function discoverLangChainJsRegisteredTools(
  toolsOrContainer: unknown,
  runtimeName?: string,
): LangChainJsRegisteredToolSnapshot {
  const extracted = extractLangChainTools(toolsOrContainer);
  const tools = extracted.tools.map((tool, index) =>
    observeLangChainTool(
      tool,
      "RUNTIME_REGISTERED",
      index,
      runtimeName,
    ),
  );

  return {
    framework: "langchain-js",
    ...(runtimeName ? { runtimeName } : {}),
    containerKind: extracted.kind,
    registeredToolCount: tools.length,
    tools,
    externalCallsMade: false,
    toolInvocationsMade: false,
    getterCallsMade: false,
    secretValuesRetained: false,
  };
}

export function discoverLangChainJsModelVisibleTools(
  toolsPassedToBindTools: unknown,
  runtimeName?: string,
): LangChainJsModelVisibleToolSnapshot {
  const extracted = extractLangChainTools(toolsPassedToBindTools);
  const tools = extracted.tools.map((tool, index) =>
    observeLangChainTool(
      tool,
      "MODEL_VISIBLE",
      index,
      runtimeName,
    ),
  );

  return {
    framework: "langchain-js",
    ...(runtimeName ? { runtimeName } : {}),
    containerKind: extracted.kind,
    modelVisibleToolCount: tools.length,
    tools,
    externalCallsMade: false,
    toolInvocationsMade: false,
    getterCallsMade: false,
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

function correlationKey(tool: FrameworkRuntimeToolObservation): string {
  return JSON.stringify({
    name: tool.canonicalName,
    type: tool.toolType,
    description: tool.description,
    inputSchema: tool.inputSchema,
    safeMetadata: tool.safeMetadata,
  });
}

export function mergeFrameworkRuntimeToolEvidence(
  ...snapshots: readonly FrameworkRuntimeToolSnapshot[]
): MergedFrameworkRuntimeToolSnapshot {
  const merged = new Map<string, FrameworkRuntimeToolObservation>();

  for (const snapshot of snapshots) {
    for (const tool of snapshot.tools) {
      const key = correlationKey(tool);
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

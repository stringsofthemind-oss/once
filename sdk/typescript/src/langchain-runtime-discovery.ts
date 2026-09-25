import { createHash } from "node:crypto";

import {
  assessToolImportance,
  type ToolImportanceAssessment,
} from "./tool-importance.js";

import type {
  RuntimeToolObservation,
} from "./runtime-tool-discovery.js";

type JsonRecord = Record<string, unknown>;

export type LangChainRuntimeToolObservation = RuntimeToolObservation & {
  framework: "langchain";
  origin: RuntimeToolObservation["origin"] & {
    source: "langchain.tools" | "langchain.bindTools";
  };
};

export type LangChainRegisteredToolSnapshot = {
  framework: "langchain";
  runtimeName?: string;
  registeredToolCount: number;
  tools: LangChainRuntimeToolObservation[];
  externalCallsMade: false;
  toolInvocationsMade: false;
  secretValuesRetained: false;
};

export type LangChainModelVisibleToolSnapshot = {
  framework: "langchain";
  runtimeName?: string;
  modelVisibleToolCount: number;
  tools: LangChainRuntimeToolObservation[];
  externalCallsMade: false;
  toolInvocationsMade: false;
  secretValuesRetained: false;
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

function stableId(value: unknown): string {
  return `tool:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : undefined;
}

const secretNamePattern =
  /(?:^|[_-])(authorization|api[_-]?key|token|password|passwd|secret|credential|cookie)(?:$|[_-])/i;

function safeJsonData(
  value: unknown,
  depth = 0,
  seen: Set<object> = new Set(),
  secretContext = false,
): unknown | undefined {
  if (value === null) return null;

  if (
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
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

  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return undefined;
  }

  seen.add(objectValue);

  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];

      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );

        if (!descriptor || !("value" in descriptor)) {
          return undefined;
        }

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

    const output: JsonRecord = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) continue;
      if (descriptor.value === undefined) continue;

      const child = safeJsonData(
        descriptor.value,
        depth + 1,
        seen,
        secretContext || secretNamePattern.test(key),
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

function langChainTools(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;

  const record = asRecord(input);
  if (!record) return [];

  const tools = ownDataValue(record, "tools");
  return Array.isArray(tools) ? tools : [];
}

function openAiFormattedFunction(tool: JsonRecord): JsonRecord | undefined {
  const type = stringValue(ownDataValue(tool, "type"));
  if (type !== "function") return undefined;
  return asRecord(ownDataValue(tool, "function"));
}

function observeLangChainTool(
  rawTool: unknown,
  evidence: "RUNTIME_REGISTERED" | "MODEL_VISIBLE",
  source: "langchain.tools" | "langchain.bindTools",
  index: number,
  runtimeName?: string,
): LangChainRuntimeToolObservation | undefined {
  const tool = asRecord(rawTool);
  if (!tool) return undefined;

  const formatted = openAiFormattedFunction(tool);

  const name =
    stringValue(ownDataValue(tool, "name")) ??
    stringValue(ownDataValue(formatted, "name"));

  if (!name) return undefined;

  const description =
    stringValue(ownDataValue(tool, "description")) ??
    stringValue(ownDataValue(formatted, "description")) ??
    "";

  const rawSchema =
    ownDataValue(tool, "schema") ??
    ownDataValue(tool, "inputSchema") ??
    ownDataValue(tool, "parameters") ??
    ownDataValue(formatted, "parameters");

  const schema = safeJsonData(rawSchema);
  const schemaOpaque =
    rawSchema !== undefined &&
    schema === undefined;

  const autoExecutable = [
    ownDataValue(tool, "invoke"),
    ownDataValue(tool, "call"),
    ownDataValue(tool, "func"),
  ].some(value => typeof value === "function");

  const returnDirect =
    typeof ownDataValue(tool, "returnDirect") === "boolean"
      ? ownDataValue(tool, "returnDirect") as boolean
      : undefined;

  const namespace =
    `langchain/${runtimeName ?? "runtime"}`;

  const toolType = formatted
    ? "function"
    : "structured_tool";

  const safeMetadata = {
    autoExecutable,
    ...(schemaOpaque ? { schemaOpaque: true } : {}),
    ...(returnDirect !== undefined ? { returnDirect } : {}),
  };

  const once: ToolImportanceAssessment = assessToolImportance({
    name,
    description,
    sourceCategory: toolType,
    evidence,
    readOnlyHint:
      /(?:^|[_-])(?:search|lookup|retrieve|fetch|get|list|read|find)(?:$|[_-])/i.test(name)
        ? true
        : undefined,
  });

  return {
    toolId: stableId({
      framework: "langchain",
      namespace,
      name,
      toolType,
      description,
      schema,
    }),
    namespacedName: `${namespace}/${name}`,
    canonicalName: name,
    displayName: name,
    description,
    toolType,
    framework: "langchain",
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
    safeMetadata,
    once,
  } as LangChainRuntimeToolObservation;
}

function discover(
  input: unknown,
  evidence: "RUNTIME_REGISTERED" | "MODEL_VISIBLE",
  source: "langchain.tools" | "langchain.bindTools",
  runtimeName?: string,
): LangChainRuntimeToolObservation[] {
  return langChainTools(input)
    .map((tool, index) =>
      observeLangChainTool(
        tool,
        evidence,
        source,
        index,
        runtimeName,
      ),
    )
    .filter(
      (tool): tool is LangChainRuntimeToolObservation =>
        Boolean(tool),
    );
}

export function discoverLangChainRegisteredTools(
  toolsOrAgentConfig: unknown,
  runtimeName?: string,
): LangChainRegisteredToolSnapshot {
  const tools = discover(
    toolsOrAgentConfig,
    "RUNTIME_REGISTERED",
    "langchain.tools",
    runtimeName,
  );

  return {
    framework: "langchain",
    ...(runtimeName ? { runtimeName } : {}),
    registeredToolCount: tools.length,
    tools,
    externalCallsMade: false,
    toolInvocationsMade: false,
    secretValuesRetained: false,
  };
}

export function discoverLangChainModelVisibleTools(
  toolsPassedToBindTools: unknown,
  runtimeName?: string,
): LangChainModelVisibleToolSnapshot {
  const tools = discover(
    toolsPassedToBindTools,
    "MODEL_VISIBLE",
    "langchain.bindTools",
    runtimeName,
  );

  return {
    framework: "langchain",
    ...(runtimeName ? { runtimeName } : {}),
    modelVisibleToolCount: tools.length,
    tools,
    externalCallsMade: false,
    toolInvocationsMade: false,
    secretValuesRetained: false,
  };
}

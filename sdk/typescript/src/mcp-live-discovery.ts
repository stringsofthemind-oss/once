import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assessToolImportance,
  type ToolImportanceAssessment,
} from "./tool-importance.js";

import type {
  ConfiguredToolSource,
} from "./tool-discovery.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_TOOLS = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;

export type McpProtocolEra =
  | "MODERN_2026"
  | "LEGACY_2025";

export type McpLiveProbeStatus =
  | "ENUMERATED"
  | "SKIPPED_STDIO"
  | "SKIPPED_UNSUPPORTED_TRANSPORT"
  | "FAILED";

export type McpLiveProbe = {
  sourceId: string;
  source: string;
  status: McpLiveProbeStatus;
  endpoint?: string;
  protocolEra?: McpProtocolEra;
  protocolVersion?: string;
  pages: number;
  toolCount: number;
  errorCode?: string;
};

export type McpAuthoritativeToolRecord = {
  toolId: string;
  canonicalName: string;
  displayName: string;
  description: string;
  origin: {
    kind: "mcp";
    host: string;
    server: string;
    scope: "PROJECT" | "USER";
  };
  source: {
    sourceId: string;
    endpoint: string;
  };
  evidence: {
    level: "SERVER_AUTHORITATIVE";
    source: string;
  };
  visibility: {
    configured: true;
    runtimeRegistered: false;
    modelVisible: false;
    executed: false;
  };
  inputSchema?: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  once: ToolImportanceAssessment;
};

export type McpLiveDiscoveryResult = {
  mode: "EXPLICIT_REMOTE_HTTP";
  externalServersContacted: number;
  stdioServersLaunched: false;
  redirectsFollowed: false;
  secretValuesRetained: false;
  probes: McpLiveProbe[];
  tools: McpAuthoritativeToolRecord[];
};

export type McpLiveDiscoveryOptions = {
  timeoutMs?: number;
  maxPages?: number;
  maxTools?: number;
  maxResponseBytes?: number;
};

type JsonRecord = Record<string, unknown>;

type RemoteTarget = {
  source: ConfiguredToolSource;
  url: string;
  headers: Record<string, string>;
};

type RpcResult = {
  payload: JsonRecord;
  sessionId?: string;
};

export class McpLiveDiscoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpLiveDiscoveryError";
  }
}

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

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index] ?? "";
    const next = input[index + 1] ?? "";

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index++;
      } else if (char === "\n") {
        output += char;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }

    output += char;
  }

  return output;
}

function serverMapsFromJson(parsed: unknown): JsonRecord[] {
  const root = asRecord(parsed);
  if (!root) return [];

  const maps: JsonRecord[] = [];

  for (const key of ["mcpServers", "servers"]) {
    const value = asRecord(root[key]);
    if (value) maps.push(value);
  }

  const customizations = asRecord(root.customizations);
  const vscode = asRecord(customizations?.vscode);
  const mcp = asRecord(vscode?.mcp);

  for (const key of ["mcpServers", "servers"]) {
    const value = asRecord(mcp?.[key]);
    if (value) maps.push(value);
  }

  return maps;
}

function configPathToAbsolute(root: string, configPath: string): string {
  if (configPath === "~") {
    return os.homedir();
  }

  if (configPath.startsWith("~/")) {
    return path.join(
      os.homedir(),
      ...configPath.substring(2).split("/"),
    );
  }

  if (path.isAbsolute(configPath)) {
    return configPath;
  }

  return path.resolve(root, configPath);
}

function stringHeaders(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};

  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      headers[key] = item;
    }
  }

  return headers;
}

function parseTomlString(raw: string): string | undefined {
  const value = raw.trim();
  const match = value.match(/^(?:"((?:\\.|[^"])*)"|'([^']*)')$/);
  if (!match) return undefined;

  const body = match[1] ?? match[2] ?? "";
  return body.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

async function resolveJsonTarget(
  root: string,
  source: ConfiguredToolSource,
): Promise<RemoteTarget | undefined> {
  const filePath = configPathToAbsolute(root, source.configPath);
  let raw: string;

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      stripJsonComments(raw.replace(/^\uFEFF/, "")),
    );
  } catch {
    return undefined;
  }

  for (const serverMap of serverMapsFromJson(parsed)) {
    const definition = asRecord(serverMap[source.name]);
    if (!definition || typeof definition.url !== "string") {
      continue;
    }

    return {
      source,
      url: definition.url,
      headers: stringHeaders(definition.headers),
    };
  }

  return undefined;
}

async function resolveCodexTarget(
  root: string,
  source: ConfiguredToolSource,
): Promise<RemoteTarget | undefined> {
  const filePath = configPathToAbsolute(root, source.configPath);
  let raw: string;

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  const escapedName = source.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionPattern = new RegExp(
    `^\\s*\\[mcp_servers\\.(?:${escapedName}|"${escapedName}"|'${escapedName}')\\]\\s*$`,
    "m",
  );
  const match = sectionPattern.exec(raw);
  if (!match) return undefined;

  const sectionStart = (match.index ?? 0) + match[0].length;
  const rest = raw.substring(sectionStart);
  const nextSection = rest.search(/^\s*\[/m);
  const section = nextSection >= 0 ? rest.substring(0, nextSection) : rest;
  const urlMatch = section.match(/^\s*url\s*=\s*(.+?)\s*$/m);
  if (!urlMatch) return undefined;

  const url = parseTomlString(urlMatch[1] ?? "");
  if (!url) return undefined;

  return {
    source,
    url,
    headers: {},
  };
}

async function resolveRemoteTarget(
  root: string,
  source: ConfiguredToolSource,
): Promise<RemoteTarget | undefined> {
  if (source.host === "codex" || source.configPath.endsWith(".toml")) {
    return resolveCodexTarget(root, source);
  }

  return resolveJsonTarget(root, source);
}

function safeEndpointLabel(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname}`;
}

function validateRemoteUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new McpLiveDiscoveryError(
      "INVALID_ENDPOINT",
      "Configured MCP endpoint is not a valid URL.",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpLiveDiscoveryError(
      "UNSUPPORTED_ENDPOINT_SCHEME",
      "Phase 11B live enumeration supports HTTP(S) endpoints only.",
    );
  }

  return url;
}

async function readResponseBodyLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new McpLiveDiscoveryError(
      "RESPONSE_TOO_LARGE",
      "MCP response exceeded the configured response-size limit.",
    );
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;

    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new McpLiveDiscoveryError(
        "RESPONSE_TOO_LARGE",
        "MCP response exceeded the configured response-size limit.",
      );
    }

    text += decoder.decode(chunk.value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

function parseRpcPayload(text: string, contentType: string): JsonRecord {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new McpLiveDiscoveryError(
      "EMPTY_RESPONSE",
      "MCP endpoint returned an empty RPC response.",
    );
  }

  if (contentType.toLowerCase().includes("text/event-stream")) {
    const candidates = trimmed
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.substring(5).trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        const record = asRecord(parsed);
        if (record) return record;
      } catch {
        // Ignore non-JSON SSE data frames.
      }
    }

    throw new McpLiveDiscoveryError(
      "INVALID_SSE_RESPONSE",
      "MCP SSE response did not contain a JSON-RPC data frame.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new McpLiveDiscoveryError(
      "INVALID_JSON_RESPONSE",
      "MCP endpoint returned invalid JSON.",
    );
  }

  const record = asRecord(parsed);
  if (!record) {
    throw new McpLiveDiscoveryError(
      "INVALID_RPC_RESPONSE",
      "MCP endpoint returned a non-object RPC response.",
    );
  }

  return record;
}

async function postRpc(
  target: RemoteTarget,
  payload: JsonRecord,
  method: string,
  timeoutMs: number,
  maxResponseBytes: number,
  extraHeaders: Record<string, string> = {},
): Promise<RpcResult> {
  const url = validateRemoteUrl(target.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        ...target.headers,
        ...extraHeaders,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Mcp-Method": method,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new McpLiveDiscoveryError(
        "TIMEOUT",
        "MCP request exceeded the configured timeout.",
      );
    }

    throw new McpLiveDiscoveryError(
      "NETWORK_ERROR",
      "MCP endpoint could not be reached.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new McpLiveDiscoveryError(
      "REDIRECT_BLOCKED",
      "MCP endpoint returned a redirect; Phase 11B does not follow redirects.",
    );
  }

  if (!response.ok) {
    throw new McpLiveDiscoveryError(
      `HTTP_${response.status}`,
      `MCP endpoint returned HTTP ${response.status}.`,
    );
  }

  const text = await readResponseBodyLimited(response, maxResponseBytes);
  const rpc = parseRpcPayload(
    text,
    response.headers.get("content-type") ?? "",
  );

  return {
    payload: rpc,
    sessionId:
      response.headers.get("mcp-session-id") ?? undefined,
  };
}

async function postNotification(
  target: RemoteTarget,
  payload: JsonRecord,
  method: string,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const url = validateRemoteUrl(target.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        ...target.headers,
        ...extraHeaders,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Mcp-Method": method,
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new McpLiveDiscoveryError(
        "TIMEOUT",
        "MCP notification exceeded the configured timeout.",
      );
    }

    throw new McpLiveDiscoveryError(
      "NETWORK_ERROR",
      "MCP endpoint could not be reached.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new McpLiveDiscoveryError(
      "REDIRECT_BLOCKED",
      "MCP endpoint returned a redirect; Phase 11B does not follow redirects.",
    );
  }

  if (!response.ok) {
    throw new McpLiveDiscoveryError(
      `HTTP_${response.status}`,
      `MCP endpoint returned HTTP ${response.status}.`,
    );
  }

  await response.body?.cancel();
}

function rpcResult(payload: JsonRecord): JsonRecord {
  const error = asRecord(payload.error);
  if (error) {
    const code = typeof error.code === "number" ? error.code : undefined;
    throw new McpLiveDiscoveryError(
      code === -32601 ? "RPC_METHOD_NOT_FOUND" : "RPC_ERROR",
      "MCP endpoint returned a JSON-RPC error.",
    );
  }

  const result = asRecord(payload.result);
  if (!result) {
    throw new McpLiveDiscoveryError(
      "INVALID_RPC_RESULT",
      "MCP endpoint returned no object result.",
    );
  }

  return result;
}

function modernMeta(): JsonRecord {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {
      name: "once-tool-discovery",
      version: "phase11b-v1",
    },
  };
}

async function discoverModern(
  target: RemoteTarget,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<string> {
  const response = await postRpc(
    target,
    {
      jsonrpc: "2.0",
      id: "once-discover-1",
      method: "server/discover",
      params: {
        _meta: modernMeta(),
      },
    },
    "server/discover",
    timeoutMs,
    maxResponseBytes,
    {
      "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
    },
  );

  const result = rpcResult(response.payload);
  const supported = Array.isArray(result.supportedVersions)
    ? result.supportedVersions.filter(item => typeof item === "string")
    : [];

  if (!supported.includes(MODERN_PROTOCOL_VERSION)) {
    throw new McpLiveDiscoveryError(
      "MODERN_VERSION_UNSUPPORTED",
      "MCP server discovery did not advertise the modern protocol version.",
    );
  }

  return MODERN_PROTOCOL_VERSION;
}

async function initializeLegacy(
  target: RemoteTarget,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<{
  protocolVersion: string;
  sessionId?: string;
}> {
  const response = await postRpc(
    target,
    {
      jsonrpc: "2.0",
      id: "once-initialize-1",
      method: "initialize",
      params: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "once-tool-discovery",
          version: "phase11b-v1",
        },
      },
    },
    "initialize",
    timeoutMs,
    maxResponseBytes,
    {
      "MCP-Protocol-Version": LEGACY_PROTOCOL_VERSION,
    },
  );

  const result = rpcResult(response.payload);
  const protocolVersion =
    typeof result.protocolVersion === "string"
      ? result.protocolVersion
      : LEGACY_PROTOCOL_VERSION;

  const sessionHeaders: Record<string, string> = {
    "MCP-Protocol-Version": protocolVersion,
  };
  if (response.sessionId) {
    sessionHeaders["Mcp-Session-Id"] = response.sessionId;
  }

  await postNotification(
    target,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    "notifications/initialized",
    timeoutMs,
    sessionHeaders,
  );

  return {
    protocolVersion,
    sessionId: response.sessionId,
  };
}

function sanitizeAnnotations(value: unknown): McpAuthoritativeToolRecord["annotations"] {
  const source = asRecord(value);
  if (!source) return undefined;

  const annotations: NonNullable<McpAuthoritativeToolRecord["annotations"]> = {};

  if (typeof source.title === "string") {
    annotations.title = source.title;
  }
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    if (typeof source[key] === "boolean") {
      annotations[key] = source[key];
    }
  }

  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

function toolRecord(
  target: RemoteTarget,
  endpoint: string,
  rawTool: unknown,
): McpAuthoritativeToolRecord | undefined {
  const tool = asRecord(rawTool);
  if (!tool || typeof tool.name !== "string" || tool.name.trim() === "") {
    return undefined;
  }

  const name = tool.name;
  const description =
    typeof tool.description === "string" ? tool.description : "";
  const annotations = sanitizeAnnotations(tool.annotations);

  return {
    toolId: stableId("tool", {
      kind: "mcp",
      sourceId: target.source.sourceId,
      name,
    }),
    canonicalName: name,
    displayName: annotations?.title ?? name,
    description,
    origin: {
      kind: "mcp",
      host: target.source.host,
      server: target.source.name,
      scope: target.source.scope,
    },
    source: {
      sourceId: target.source.sourceId,
      endpoint,
    },
    evidence: {
      level: "SERVER_AUTHORITATIVE",
      source: `mcp:${target.source.host}/${target.source.name}`,
    },
    visibility: {
      configured: true,
      runtimeRegistered: false,
      modelVisible: false,
      executed: false,
    },
    ...(tool.inputSchema !== undefined
      ? { inputSchema: tool.inputSchema }
      : {}),
    ...(annotations ? { annotations } : {}),
    once: assessToolImportance({
      name,
      description,
      evidence: "SERVER_AUTHORITATIVE",
      readOnlyHint: annotations?.readOnlyHint,
    }),
  };
}

async function listTools(
  target: RemoteTarget,
  era: McpProtocolEra,
  protocolVersion: string,
  sessionId: string | undefined,
  options: Required<McpLiveDiscoveryOptions>,
): Promise<{
  pages: number;
  tools: McpAuthoritativeToolRecord[];
}> {
  const tools: McpAuthoritativeToolRecord[] = [];
  const seenCursors = new Set<string>();
  const endpoint = safeEndpointLabel(target.url);
  let cursor: string | undefined;
  let pages = 0;

  while (true) {
    if (pages >= options.maxPages) {
      throw new McpLiveDiscoveryError(
        "PAGINATION_LIMIT",
        "MCP tools/list exceeded the configured page limit.",
      );
    }

    const params: JsonRecord = {};
    if (cursor) params.cursor = cursor;
    if (era === "MODERN_2026") {
      params._meta = modernMeta();
    }

    const headers: Record<string, string> = {
      "MCP-Protocol-Version": protocolVersion,
    };
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
    }

    const response = await postRpc(
      target,
      {
        jsonrpc: "2.0",
        id: `once-tools-${pages + 1}`,
        method: "tools/list",
        params,
      },
      "tools/list",
      options.timeoutMs,
      options.maxResponseBytes,
      headers,
    );

    const result = rpcResult(response.payload);
    const pageTools = Array.isArray(result.tools) ? result.tools : [];

    for (const rawTool of pageTools) {
      const record = toolRecord(target, endpoint, rawTool);
      if (record) tools.push(record);

      if (tools.length > options.maxTools) {
        throw new McpLiveDiscoveryError(
          "TOOL_LIMIT",
          "MCP tools/list exceeded the configured tool limit.",
        );
      }
    }

    pages++;

    const nextCursor =
      typeof result.nextCursor === "string" && result.nextCursor !== ""
        ? result.nextCursor
        : undefined;

    if (!nextCursor) break;

    if (seenCursors.has(nextCursor)) {
      throw new McpLiveDiscoveryError(
        "CURSOR_LOOP",
        "MCP tools/list repeated a pagination cursor.",
      );
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { pages, tools };
}

async function enumerateTarget(
  target: RemoteTarget,
  options: Required<McpLiveDiscoveryOptions>,
): Promise<{
  probe: McpLiveProbe;
  tools: McpAuthoritativeToolRecord[];
}> {
  const endpoint = safeEndpointLabel(target.url);
  let era: McpProtocolEra;
  let protocolVersion: string;
  let sessionId: string | undefined;

  try {
    protocolVersion = await discoverModern(
      target,
      options.timeoutMs,
      options.maxResponseBytes,
    );
    era = "MODERN_2026";
  } catch (error) {
    const code =
      error instanceof McpLiveDiscoveryError ? error.code : "UNKNOWN";

    if (
      code !== "RPC_METHOD_NOT_FOUND" &&
      code !== "MODERN_VERSION_UNSUPPORTED" &&
      code !== "HTTP_400" &&
      code !== "HTTP_404" &&
      code !== "HTTP_405"
    ) {
      throw error;
    }

    const legacy = await initializeLegacy(
      target,
      options.timeoutMs,
      options.maxResponseBytes,
    );
    era = "LEGACY_2025";
    protocolVersion = legacy.protocolVersion;
    sessionId = legacy.sessionId;
  }

  const listed = await listTools(
    target,
    era,
    protocolVersion,
    sessionId,
    options,
  );

  return {
    probe: {
      sourceId: target.source.sourceId,
      source: `${target.source.host}/${target.source.name}`,
      status: "ENUMERATED",
      endpoint,
      protocolEra: era,
      protocolVersion,
      pages: listed.pages,
      toolCount: listed.tools.length,
    },
    tools: listed.tools,
  };
}

function normalizedOptions(
  options: McpLiveDiscoveryOptions,
): Required<McpLiveDiscoveryOptions> {
  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
    maxTools: options.maxTools ?? DEFAULT_MAX_TOOLS,
    maxResponseBytes:
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  };
}

function selectSources(
  sources: readonly ConfiguredToolSource[],
  selectors: readonly string[],
): ConfiguredToolSource[] {
  if (selectors.length === 0) {
    throw new McpLiveDiscoveryError(
      "EXPLICIT_SELECTION_REQUIRED",
      "Live MCP enumeration requires at least one explicit configured server selector.",
    );
  }

  const selected: ConfiguredToolSource[] = [];

  for (const selector of selectors) {
    const exact = sources.filter(source =>
      source.sourceId === selector ||
      `${source.host}/${source.name}` === selector,
    );

    const matches = exact.length > 0
      ? exact
      : sources.filter(source => source.name === selector);

    if (matches.length === 0) {
      throw new McpLiveDiscoveryError(
        "SELECTOR_NOT_FOUND",
        `Configured MCP server selector not found: ${selector}`,
      );
    }

    if (matches.length > 1) {
      throw new McpLiveDiscoveryError(
        "SELECTOR_AMBIGUOUS",
        `Configured MCP server selector is ambiguous; use host/name: ${selector}`,
      );
    }

    if (!selected.some(source => source.sourceId === matches[0]?.sourceId)) {
      selected.push(matches[0]!);
    }
  }

  return selected;
}

export async function discoverLiveMcpTools(
  root: string,
  configuredSources: readonly ConfiguredToolSource[],
  selectors: readonly string[],
  options: McpLiveDiscoveryOptions = {},
): Promise<McpLiveDiscoveryResult> {
  const selected = selectSources(configuredSources, selectors);
  const resolvedOptions = normalizedOptions(options);
  const probes: McpLiveProbe[] = [];
  const tools: McpAuthoritativeToolRecord[] = [];
  let externalServersContacted = 0;

  for (const source of selected) {
    if (source.transport === "STDIO") {
      probes.push({
        sourceId: source.sourceId,
        source: `${source.host}/${source.name}`,
        status: "SKIPPED_STDIO",
        pages: 0,
        toolCount: 0,
      });
      continue;
    }

    if (source.transport === "SSE") {
      probes.push({
        sourceId: source.sourceId,
        source: `${source.host}/${source.name}`,
        status: "SKIPPED_UNSUPPORTED_TRANSPORT",
        pages: 0,
        toolCount: 0,
        errorCode: "SSE_NOT_SUPPORTED_IN_11B_V1",
      });
      continue;
    }

    const target = await resolveRemoteTarget(root, source);
    if (!target) {
      probes.push({
        sourceId: source.sourceId,
        source: `${source.host}/${source.name}`,
        status: "FAILED",
        pages: 0,
        toolCount: 0,
        errorCode: "REMOTE_ENDPOINT_NOT_RESOLVED",
      });
      continue;
    }

    externalServersContacted++;

    try {
      const enumerated = await enumerateTarget(target, resolvedOptions);
      probes.push(enumerated.probe);
      tools.push(...enumerated.tools);
    } catch (error) {
      probes.push({
        sourceId: source.sourceId,
        source: `${source.host}/${source.name}`,
        status: "FAILED",
        endpoint: safeEndpointLabel(target.url),
        pages: 0,
        toolCount: 0,
        errorCode:
          error instanceof McpLiveDiscoveryError
            ? error.code
            : "UNKNOWN_ERROR",
      });
    }
  }

  return {
    mode: "EXPLICIT_REMOTE_HTTP",
    externalServersContacted,
    stdioServersLaunched: false,
    redirectsFollowed: false,
    secretValuesRetained: false,
    probes,
    tools,
  };
}

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  discoverLiveMcpTools,
  type McpAuthoritativeToolRecord,
  type McpLiveDiscoveryResult,
} from "./mcp-live-discovery.js";

import type {
  ConfiguredToolSource,
} from "./tool-discovery.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const DEFAULT_WATCH_MS = 5_000;
const DEFAULT_MAX_STREAM_BYTES = 1_000_000;

type JsonRecord = Record<string, unknown>;

type RemoteTarget = {
  source: ConfiguredToolSource;
  url: string;
  headers: Record<string, string>;
};

export type McpToolRefreshStatus =
  | "CHANGED"
  | "NO_CHANGE"
  | "UNSUPPORTED_LEGACY"
  | "SUBSCRIPTION_NOT_ACKNOWLEDGED"
  | "FAILED";

export type McpToolRefreshDiff = {
  added: string[];
  removed: string[];
  changed: string[];
};

export type McpToolRefreshResult = {
  source: string;
  status: McpToolRefreshStatus;
  namespace: string;
  watchMs: number;
  acknowledged: boolean;
  changeNotificationReceived: boolean;
  beforeCount: number;
  afterCount: number;
  diff: McpToolRefreshDiff;
  refreshed?: McpLiveDiscoveryResult;
  errorCode?: string;
};

export type McpToolRefreshOptions = {
  watchMs?: number;
  maxStreamBytes?: number;
};

export class McpToolRefreshError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpToolRefreshError";
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

function absoluteConfigPath(root: string, configPath: string): string {
  if (configPath === "~") return os.homedir();
  if (configPath.startsWith("~/")) {
    return path.join(
      os.homedir(),
      ...configPath.substring(2).split("/"),
    );
  }
  if (path.isAbsolute(configPath)) return configPath;
  return path.resolve(root, configPath);
}

function stringHeaders(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};

  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") headers[key] = item;
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

async function resolveTarget(
  root: string,
  source: ConfiguredToolSource,
): Promise<RemoteTarget | undefined> {
  const filePath = absoluteConfigPath(root, source.configPath);
  let raw: string;

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  if (source.host === "codex" || source.configPath.endsWith(".toml")) {
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
    const url = urlMatch ? parseTomlString(urlMatch[1] ?? "") : undefined;
    return url ? { source, url, headers: {} } : undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw.replace(/^\uFEFF/, "")));
  } catch {
    return undefined;
  }

  for (const serverMap of serverMapsFromJson(parsed)) {
    const definition = asRecord(serverMap[source.name]);
    if (!definition || typeof definition.url !== "string") continue;
    return {
      source,
      url: definition.url,
      headers: stringHeaders(definition.headers),
    };
  }

  return undefined;
}

function selectOneSource(
  sources: readonly ConfiguredToolSource[],
  selector: string,
): ConfiguredToolSource {
  const exact = sources.filter(source =>
    source.sourceId === selector ||
    `${source.host}/${source.name}` === selector,
  );

  const matches = exact.length > 0
    ? exact
    : sources.filter(source => source.name === selector);

  if (matches.length === 0) {
    throw new McpToolRefreshError(
      "SELECTOR_NOT_FOUND",
      `Configured MCP server selector not found: ${selector}`,
    );
  }

  if (matches.length > 1) {
    throw new McpToolRefreshError(
      "SELECTOR_AMBIGUOUS",
      `Configured MCP server selector is ambiguous; use host/name: ${selector}`,
    );
  }

  return matches[0]!;
}

function modernMeta(): JsonRecord {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {
      name: "once-tool-discovery",
      version: "phase11b-refresh-v1",
    },
  };
}

function namespacedName(tool: McpAuthoritativeToolRecord): string {
  return `${tool.origin.host}/${tool.origin.server}/${tool.canonicalName}`;
}

function stableToolShape(tool: McpAuthoritativeToolRecord): string {
  return JSON.stringify({
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  });
}

export function diffMcpToolSnapshots(
  before: readonly McpAuthoritativeToolRecord[],
  after: readonly McpAuthoritativeToolRecord[],
): McpToolRefreshDiff {
  const beforeMap = new Map(
    before.map(tool => [namespacedName(tool), tool] as const),
  );
  const afterMap = new Map(
    after.map(tool => [namespacedName(tool), tool] as const),
  );

  const added = [...afterMap.keys()]
    .filter(name => !beforeMap.has(name))
    .sort();
  const removed = [...beforeMap.keys()]
    .filter(name => !afterMap.has(name))
    .sort();
  const changed = [...afterMap.keys()]
    .filter(name => {
      const prior = beforeMap.get(name);
      const current = afterMap.get(name);
      return Boolean(
        prior && current &&
        stableToolShape(prior) !== stableToolShape(current),
      );
    })
    .sort();

  return { added, removed, changed };
}

export function rankMcpSourcePrecedence(
  sources: readonly ConfiguredToolSource[],
): ConfiguredToolSource[] {
  return [...sources].sort((left, right) => {
    const leftScope = left.scope === "PROJECT" ? 0 : 1;
    const rightScope = right.scope === "PROJECT" ? 0 : 1;

    return (
      leftScope - rightScope ||
      left.host.localeCompare(right.host) ||
      left.name.localeCompare(right.name) ||
      left.configPath.localeCompare(right.configPath)
    );
  });
}

async function waitForModernToolChange(
  target: RemoteTarget,
  watchMs: number,
  maxStreamBytes: number,
): Promise<{
  acknowledged: boolean;
  changed: boolean;
}> {
  let endpoint: URL;
  try {
    endpoint = new URL(target.url);
  } catch {
    throw new McpToolRefreshError(
      "INVALID_ENDPOINT",
      "Configured MCP endpoint is not a valid URL.",
    );
  }

  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new McpToolRefreshError(
      "UNSUPPORTED_ENDPOINT_SCHEME",
      "MCP tool refresh supports HTTP(S) endpoints only.",
    );
  }

  const requestId = `once-tools-listen-${Date.now()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), watchMs);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        ...target.headers,
        "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json",
        "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
        "Mcp-Method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "subscriptions/listen",
        params: {
          notifications: {
            toolsListChanged: true,
          },
          _meta: modernMeta(),
        },
      }),
    });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      return { acknowledged: false, changed: false };
    }
    throw new McpToolRefreshError(
      "NETWORK_ERROR",
      "MCP subscription endpoint could not be reached.",
    );
  }

  if (response.status >= 300 && response.status < 400) {
    clearTimeout(timer);
    controller.abort();
    throw new McpToolRefreshError(
      "REDIRECT_BLOCKED",
      "MCP subscription returned a redirect; redirects are not followed.",
    );
  }

  if (!response.ok || !response.body) {
    clearTimeout(timer);
    controller.abort();
    throw new McpToolRefreshError(
      `HTTP_${response.status}`,
      `MCP subscription returned HTTP ${response.status}.`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let acknowledged = false;
  let changed = false;

  try {
    while (true) {
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await reader.read();
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") break;
        throw error;
      }

      if (item.done) break;
      totalBytes += item.value.byteLength;
      if (totalBytes > maxStreamBytes) {
        throw new McpToolRefreshError(
          "STREAM_TOO_LARGE",
          "MCP subscription exceeded the configured stream-size limit.",
        );
      }

      buffer += decoder.decode(item.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter(line => line.startsWith("data:"))
          .map(line => line.substring(5).trim())
          .join("\n");

        if (!data) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const event = asRecord(parsed);
        if (!event) continue;
        const method = typeof event.method === "string" ? event.method : "";
        const params = asRecord(event.params);
        const meta = asRecord(params?._meta);
        const subscriptionId =
          meta?.["io.modelcontextprotocol/subscriptionId"];

        if (
          subscriptionId !== undefined &&
          subscriptionId !== requestId
        ) {
          continue;
        }

        if (method === "notifications/subscriptions/acknowledged") {
          acknowledged = true;
          continue;
        }

        if (method === "notifications/tools/list_changed") {
          if (acknowledged) {
            changed = true;
            return { acknowledged, changed };
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      // Stream is already closed/aborted.
    }
  }

  return { acknowledged, changed };
}

export async function watchMcpToolListOnce(
  root: string,
  configuredSources: readonly ConfiguredToolSource[],
  selector: string,
  initial: McpLiveDiscoveryResult,
  options: McpToolRefreshOptions = {},
): Promise<McpToolRefreshResult> {
  const source = selectOneSource(configuredSources, selector);
  const sourceLabel = `${source.host}/${source.name}`;
  const namespace = sourceLabel;
  const watchMs = options.watchMs ?? DEFAULT_WATCH_MS;
  const maxStreamBytes =
    options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;

  if (!Number.isFinite(watchMs) || watchMs < 50 || watchMs > 60_000) {
    throw new McpToolRefreshError(
      "INVALID_WATCH_WINDOW",
      "MCP tool watch window must be between 50 and 60000 milliseconds.",
    );
  }

  const initialProbe = initial.probes.find(
    probe => probe.sourceId === source.sourceId,
  );
  const beforeTools = initial.tools.filter(
    tool => tool.source.sourceId === source.sourceId,
  );

  if (!initialProbe || initialProbe.status !== "ENUMERATED") {
    return {
      source: sourceLabel,
      status: "FAILED",
      namespace,
      watchMs,
      acknowledged: false,
      changeNotificationReceived: false,
      beforeCount: beforeTools.length,
      afterCount: beforeTools.length,
      diff: { added: [], removed: [], changed: [] },
      errorCode: "INITIAL_ENUMERATION_REQUIRED",
    };
  }

  if (initialProbe.protocolEra !== "MODERN_2026") {
    return {
      source: sourceLabel,
      status: "UNSUPPORTED_LEGACY",
      namespace,
      watchMs,
      acknowledged: false,
      changeNotificationReceived: false,
      beforeCount: beforeTools.length,
      afterCount: beforeTools.length,
      diff: { added: [], removed: [], changed: [] },
      errorCode: "LEGACY_CHANGE_STREAM_NOT_SUPPORTED_IN_11B_V1",
    };
  }

  const target = await resolveTarget(root, source);
  if (!target) {
    return {
      source: sourceLabel,
      status: "FAILED",
      namespace,
      watchMs,
      acknowledged: false,
      changeNotificationReceived: false,
      beforeCount: beforeTools.length,
      afterCount: beforeTools.length,
      diff: { added: [], removed: [], changed: [] },
      errorCode: "REMOTE_ENDPOINT_NOT_RESOLVED",
    };
  }

  try {
    const listen = await waitForModernToolChange(
      target,
      watchMs,
      maxStreamBytes,
    );

    if (!listen.acknowledged) {
      return {
        source: sourceLabel,
        status: "SUBSCRIPTION_NOT_ACKNOWLEDGED",
        namespace,
        watchMs,
        acknowledged: false,
        changeNotificationReceived: false,
        beforeCount: beforeTools.length,
        afterCount: beforeTools.length,
        diff: { added: [], removed: [], changed: [] },
      };
    }

    if (!listen.changed) {
      return {
        source: sourceLabel,
        status: "NO_CHANGE",
        namespace,
        watchMs,
        acknowledged: true,
        changeNotificationReceived: false,
        beforeCount: beforeTools.length,
        afterCount: beforeTools.length,
        diff: { added: [], removed: [], changed: [] },
      };
    }

    const refreshed = await discoverLiveMcpTools(
      root,
      configuredSources,
      [selector],
    );
    const afterTools = refreshed.tools.filter(
      tool => tool.source.sourceId === source.sourceId,
    );

    return {
      source: sourceLabel,
      status: "CHANGED",
      namespace,
      watchMs,
      acknowledged: true,
      changeNotificationReceived: true,
      beforeCount: beforeTools.length,
      afterCount: afterTools.length,
      diff: diffMcpToolSnapshots(beforeTools, afterTools),
      refreshed,
    };
  } catch (error) {
    return {
      source: sourceLabel,
      status: "FAILED",
      namespace,
      watchMs,
      acknowledged: false,
      changeNotificationReceived: false,
      beforeCount: beforeTools.length,
      afterCount: beforeTools.length,
      diff: { added: [], removed: [], changed: [] },
      errorCode:
        error instanceof McpToolRefreshError
          ? error.code
          : "UNKNOWN_ERROR",
    };
  }
}

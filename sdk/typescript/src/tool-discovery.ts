import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectSourceFiles,
  detectProjectMetadata,
  scanFile,
  type Finding
} from "./scan.js";

import {
  assessToolImportance,
  type ToolEvidenceLevel,
  type ToolImportanceAssessment
} from "./tool-importance.js";

export type ToolSourceScope =
  | "PROJECT"
  | "USER";

export type ToolTransport =
  | "STDIO"
  | "HTTP"
  | "SSE"
  | "UNKNOWN";

export type ConfiguredToolSource = {
  sourceId: string;
  kind: "MCP_SERVER";
  host: string;
  name: string;
  scope: ToolSourceScope;
  configPath: string;
  transport: ToolTransport;
  evidence: "HOST_CONFIGURED";
  status: "CONFIGURED_NOT_PROBED";
};

export type ToolGraphRecord = {
  toolId: string;
  canonicalName: string;
  displayName: string;
  description: string;
  origin: {
    kind: "source";
    host: "project";
    scope: "workspace";
  };
  framework?: string;
  source: {
    file: string;
    line?: number;
    category?: string;
  };
  evidence: {
    level: ToolEvidenceLevel;
    source: string;
  };
  visibility: {
    configured: boolean;
    runtimeRegistered: boolean;
    modelVisible: boolean;
    executed: boolean;
  };
  once: ToolImportanceAssessment;
};

export type ToolDiscoveryResult = {
  root: string;
  languages: string[];
  tooling: string[];
  configuredSources: ConfiguredToolSource[];
  tools: ToolGraphRecord[];
};

type ConfigCandidate = {
  host: string;
  scope: ToolSourceScope;
  filePath: string;
  parser: "JSON" | "CODEX_TOML";
};

function stableId(
  prefix: string,
  value: unknown
): string {
  const hash =
    createHash("sha256")
      .update(
        JSON.stringify(value)
      )
      .digest("hex");

  return `${prefix}:${hash}`;
}

function displayPath(
  root: string,
  filePath: string
): string {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(filePath);
  const home = path.resolve(os.homedir());

  if (
    resolvedFile === resolvedRoot ||
    resolvedFile.startsWith(
      resolvedRoot + path.sep
    )
  ) {
    return path.relative(
      resolvedRoot,
      resolvedFile
    ) || ".";
  }

  if (
    resolvedFile === home ||
    resolvedFile.startsWith(
      home + path.sep
    )
  ) {
    const relative =
      path.relative(home, resolvedFile);

    return relative
      ? `~/${relative.replaceAll(path.sep, "/")}`
      : "~";
  }

  return filePath;
}

function stripJsonComments(
  input: string
): string {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (
    let index = 0;
    index < input.length;
    index++
  ) {
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
      if (
        char === "*" &&
        next === "/"
      ) {
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

    if (
      char === '"' ||
      char === "'"
    ) {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (
      char === "/" &&
      next === "/"
    ) {
      lineComment = true;
      index++;
      continue;
    }

    if (
      char === "/" &&
      next === "*"
    ) {
      blockComment = true;
      index++;
      continue;
    }

    output += char;
  }

  return output;
}

function asRecord(
  value: unknown
): Record<string, unknown> | undefined {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function inferTransport(
  value: unknown
): ToolTransport {
  const record = asRecord(value);

  if (!record) {
    return "UNKNOWN";
  }

  if (
    typeof record.command === "string"
  ) {
    return "STDIO";
  }

  if (
    typeof record.url === "string"
  ) {
    const type =
      typeof record.type === "string"
        ? record.type.toLowerCase()
        : "";

    if (type.includes("sse")) {
      return "SSE";
    }

    return "HTTP";
  }

  return "UNKNOWN";
}

function serverMapsFromJson(
  parsed: unknown
): Array<Record<string, unknown>> {
  const root = asRecord(parsed);

  if (!root) {
    return [];
  }

  const maps: Array<Record<string, unknown>> = [];

  for (const key of ["mcpServers", "servers"]) {
    const value = asRecord(root[key]);

    if (value) {
      maps.push(value);
    }
  }

  const customizations =
    asRecord(root.customizations);
  const vscode =
    asRecord(customizations?.vscode);
  const mcp =
    asRecord(vscode?.mcp);

  for (const key of ["mcpServers", "servers"]) {
    const value = asRecord(mcp?.[key]);

    if (value) {
      maps.push(value);
    }
  }

  return maps;
}

async function readJsonMcpSources(
  root: string,
  candidate: ConfigCandidate
): Promise<ConfiguredToolSource[]> {
  let raw: string;

  try {
    raw = await fs.readFile(
      candidate.filePath,
      "utf8"
    );
  } catch {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(
      stripJsonComments(
        raw.replace(/^\uFEFF/, "")
      )
    );
  } catch {
    return [];
  }

  const sources: ConfiguredToolSource[] = [];

  for (const serverMap of serverMapsFromJson(parsed)) {
    for (
      const [name, definition]
      of Object.entries(serverMap)
    ) {
      const configPath =
        displayPath(root, candidate.filePath);

      sources.push({
        sourceId: stableId(
          "mcp-source",
          {
            host: candidate.host,
            scope: candidate.scope,
            configPath,
            name
          }
        ),
        kind: "MCP_SERVER",
        host: candidate.host,
        name,
        scope: candidate.scope,
        configPath,
        transport: inferTransport(definition),
        evidence: "HOST_CONFIGURED",
        status: "CONFIGURED_NOT_PROBED"
      });
    }
  }

  return sources;
}

async function readCodexSources(
  root: string,
  candidate: ConfigCandidate
): Promise<ConfiguredToolSource[]> {
  let raw: string;

  try {
    raw = await fs.readFile(
      candidate.filePath,
      "utf8"
    );
  } catch {
    return [];
  }

  const names = new Set<string>();
  const sectionPattern =
    /^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm;

  for (
    const match of raw.matchAll(sectionPattern)
  ) {
    const rawName =
      (match[1] ?? "").trim();
    const name =
      rawName.replace(
        /^(?:"([^"]+)"|'([^']+)')$/,
        (_whole, doubleQuoted, singleQuoted) =>
          doubleQuoted ?? singleQuoted ?? rawName
      );

    if (name) {
      names.add(name);
    }
  }

  const configPath =
    displayPath(root, candidate.filePath);

  return [...names].map(
    name => ({
      sourceId: stableId(
        "mcp-source",
        {
          host: candidate.host,
          scope: candidate.scope,
          configPath,
          name
        }
      ),
      kind: "MCP_SERVER" as const,
      host: candidate.host,
      name,
      scope: candidate.scope,
      configPath,
      transport: "UNKNOWN" as const,
      evidence: "HOST_CONFIGURED" as const,
      status: "CONFIGURED_NOT_PROBED" as const
    })
  );
}

function configCandidates(
  root: string
): ConfigCandidate[] {
  const home = os.homedir();
  const appData = process.env.APPDATA;

  const candidates: ConfigCandidate[] = [
    {
      host: "generic-mcp",
      scope: "PROJECT",
      filePath: path.join(root, ".mcp.json"),
      parser: "JSON"
    },
    {
      host: "cursor",
      scope: "PROJECT",
      filePath: path.join(root, ".cursor", "mcp.json"),
      parser: "JSON"
    },
    {
      host: "vscode",
      scope: "PROJECT",
      filePath: path.join(root, ".vscode", "mcp.json"),
      parser: "JSON"
    },
    {
      host: "github-copilot",
      scope: "PROJECT",
      filePath: path.join(root, ".github", "mcp.json"),
      parser: "JSON"
    },
    {
      host: "devcontainer-vscode",
      scope: "PROJECT",
      filePath: path.join(root, "devcontainer.json"),
      parser: "JSON"
    },
    {
      host: "devcontainer-vscode",
      scope: "PROJECT",
      filePath: path.join(root, ".devcontainer", "devcontainer.json"),
      parser: "JSON"
    },
    {
      host: "cursor",
      scope: "USER",
      filePath: path.join(home, ".cursor", "mcp.json"),
      parser: "JSON"
    },
    {
      host: "github-copilot",
      scope: "USER",
      filePath: path.join(home, ".copilot", "mcp-config.json"),
      parser: "JSON"
    },
    {
      host: "codex",
      scope: "USER",
      filePath: path.join(home, ".codex", "config.toml"),
      parser: "CODEX_TOML"
    },
    {
      host: "windsurf",
      scope: "USER",
      filePath: path.join(home, ".codeium", "windsurf", "mcp_config.json"),
      parser: "JSON"
    },
    {
      host: "claude-desktop",
      scope: "USER",
      filePath: path.join(home, ".config", "Claude", "claude_desktop_config.json"),
      parser: "JSON"
    },
    {
      host: "claude-desktop",
      scope: "USER",
      filePath: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      parser: "JSON"
    }
  ];

  if (appData) {
    candidates.push({
      host: "claude-desktop",
      scope: "USER",
      filePath: path.join(
        appData,
        "Claude",
        "claude_desktop_config.json"
      ),
      parser: "JSON"
    });
  }

  return candidates;
}

async function discoverConfiguredSources(
  root: string
): Promise<ConfiguredToolSource[]> {
  const sources: ConfiguredToolSource[] = [];

  for (const candidate of configCandidates(root)) {
    const discovered =
      candidate.parser === "CODEX_TOML"
        ? await readCodexSources(root, candidate)
        : await readJsonMcpSources(root, candidate);

    sources.push(...discovered);
  }

  const unique =
    new Map<string, ConfiguredToolSource>();

  for (const source of sources) {
    unique.set(source.sourceId, source);
  }

  return [...unique.values()].sort(
    (left, right) =>
      left.scope.localeCompare(right.scope) ||
      left.host.localeCompare(right.host) ||
      left.name.localeCompare(right.name)
  );
}

function findingName(
  finding: Finding
): string {
  if (finding.functionName) {
    return finding.functionName;
  }

  return `${finding.category.toLowerCase()}_${finding.line}`;
}

function toolFromFinding(
  root: string,
  finding: Finding
): ToolGraphRecord {
  const canonicalName = findingName(finding);
  const assessment =
    assessToolImportance({
      name: canonicalName,
      description: finding.reason,
      sourceCategory: finding.category,
      evidence: "SOURCE_DISCOVERED"
    });

  const sourceFile =
    finding.file.replaceAll("\\", "/");

  return {
    toolId: stableId(
      "tool",
      {
        kind: "source",
        file: sourceFile,
        line: finding.line,
        name: canonicalName,
        category: finding.category
      }
    ),
    canonicalName,
    displayName: canonicalName,
    description: finding.reason,
    origin: {
      kind: "source",
      host: "project",
      scope: "workspace"
    },
    source: {
      file: sourceFile,
      line: finding.line,
      category: finding.category
    },
    evidence: {
      level: "SOURCE_DISCOVERED",
      source: "once-consequential-scanner"
    },
    visibility: {
      configured: false,
      runtimeRegistered: false,
      modelVisible: false,
      executed: false
    },
    once: assessment
  };
}

type DeclaredTool = {
  name: string;
  line: number;
  reason: string;
};

function lineNumberAt(
  text: string,
  index: number
): number {
  return text
    .slice(0, index)
    .split("\n")
    .length;
}

async function discoverDeclaredTools(
  root: string,
  filePath: string
): Promise<ToolGraphRecord[]> {
  let text: string;

  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const declarations: DeclaredTool[] = [];

  const decoratorPattern =
    /@(?:tool|function_tool|kernel_function)(?:\([^\n)]*\))?\s*\r?\n\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/g;

  for (const match of text.matchAll(decoratorPattern)) {
    if (!match[1] || match.index === undefined) continue;

    declarations.push({
      name: match[1],
      line: lineNumberAt(text, match.index),
      reason: "Framework tool decorator discovered in source."
    });
  }

  const toolsArrayPattern =
    /\btools\s*[:=]\s*\[([^\]]{1,1200})\]/g;

  for (const match of text.matchAll(toolsArrayPattern)) {
    if (!match[1] || match.index === undefined) continue;

    const body = match[1];
    const tokenPattern =
      /(?:^|,)\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=,|$)/g;

    for (const token of body.matchAll(tokenPattern)) {
      const name = token[1];

      if (!name) continue;

      declarations.push({
        name,
        line: lineNumberAt(text, match.index),
        reason: "Tool registered in a source tools collection."
      });
    }
  }

  const relative =
    path.relative(root, filePath)
      .replaceAll("\\", "/");

  const unique =
    new Map<string, DeclaredTool>();

  for (const declaration of declarations) {
    unique.set(
      `${declaration.name}:${declaration.line}`,
      declaration
    );
  }

  return [...unique.values()].map(
    declaration => {
      const assessment =
        assessToolImportance({
          name: declaration.name,
          description: declaration.reason,
          evidence: "SOURCE_DISCOVERED"
        });

      return {
        toolId: stableId(
          "tool",
          {
            kind: "declared-tool",
            file: relative,
            line: declaration.line,
            name: declaration.name
          }
        ),
        canonicalName: declaration.name,
        displayName: declaration.name,
        description: declaration.reason,
        origin: {
          kind: "source" as const,
          host: "project" as const,
          scope: "workspace" as const
        },
        source: {
          file: relative,
          line: declaration.line
        },
        evidence: {
          level: "SOURCE_DISCOVERED" as const,
          source: "framework-registration-scan"
        },
        visibility: {
          configured: false,
          runtimeRegistered: false,
          modelVisible: false,
          executed: false
        },
        once: assessment
      };
    }
  );
}

export async function discoverToolGraph(
  requestedRoot: string
): Promise<ToolDiscoveryResult> {
  const root = path.resolve(requestedRoot);
  const metadata =
    await detectProjectMetadata(root);
  const configuredSources =
    await discoverConfiguredSources(root);
  const files =
    await collectSourceFiles(root);
  const tools: ToolGraphRecord[] = [];

  for (const file of files) {
    const findings =
      await scanFile(root, file);

    tools.push(
      ...findings.map(
        finding =>
          toolFromFinding(root, finding)
      )
    );

    tools.push(
      ...await discoverDeclaredTools(root, file)
    );
  }

  const uniqueTools =
    new Map<string, ToolGraphRecord>();

  for (const tool of tools) {
    uniqueTools.set(tool.toolId, tool);
  }

  return {
    root,
    languages: metadata.languages,
    tooling: metadata.tooling,
    configuredSources,
    tools:
      [...uniqueTools.values()].sort(
        (left, right) =>
          right.once.actionPriority.score -
            left.once.actionPriority.score ||
          right.once.criticality.score -
            left.once.criticality.score ||
          left.canonicalName.localeCompare(
            right.canonicalName
          )
      )
  };
}

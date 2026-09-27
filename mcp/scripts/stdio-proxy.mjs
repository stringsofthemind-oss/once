#!/usr/bin/env node
// Explicit proxy for a reviewed local MCP stdio server.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpExecutionBoundary } from "@once-agent/sdk/connect";
import { z } from "zod";
import { createMcpProxyServer } from "../dist/proxy-server.js";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function catalogDigest(tools) {
  return createHash("sha256").update(JSON.stringify(canonical(tools))).digest("hex");
}

function validConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      typeof config.serverId !== "string" || !config.serverId.trim() ||
      typeof config.command !== "string" || !config.command.trim() ||
      !Array.isArray(config.args) || config.args.some(arg => typeof arg !== "string") ||
      typeof config.statePath !== "string" || !config.statePath.trim() ||
      !/^[a-f0-9]{64}$/.test(config.expectedCatalogSha256) ||
      !config.tools || typeof config.tools !== "object" || Array.isArray(config.tools)) {
    throw new Error("INVALID_PROXY_CONFIG: serverId, command, args, statePath, expectedCatalogSha256 and tools are required");
  }
  for (const [name, policy] of Object.entries(config.tools)) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
        !["PROTECT", "BYPASS"].includes(policy.decision) ||
        (policy.identityFields !== undefined &&
          (!Array.isArray(policy.identityFields) || policy.identityFields.some(x => typeof x !== "string"))) ||
        (policy.effectFields !== undefined &&
          (!Array.isArray(policy.effectFields) || policy.effectFields.some(x => typeof x !== "string")))) {
      throw new Error(`INVALID_TOOL_POLICY: ${name}`);
    }
  }
  return config;
}

const ToolPageSchema = z.object({
  tools: z.array(z.object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.object({ type: z.literal("object") }).passthrough(),
  }).passthrough()),
  nextCursor: z.string().optional(),
}).passthrough();

async function listCompleteCatalog(client) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    // MCP cursors are opaque. In particular, an empty string and a repeated
    // cursor are both valid; convergence is bounded by the page limit instead
    // of making semantic assumptions about cursor values.
    const params = cursor !== undefined ? { cursor } : {};
    const result = await client.request(
      { method: "tools/list", params },
      ToolPageSchema,
    );
    if (!Array.isArray(result.tools) || tools.length + result.tools.length > 1000) {
      throw new Error("INVALID_TOOL_CATALOG: tool limit exceeded");
    }
    tools.push(...result.tools);
    if (result.nextCursor === undefined) return tools;
    cursor = result.nextCursor;
  }
  throw new Error("INVALID_TOOL_CATALOG: page limit exceeded");
}

export async function connectStdioProxy(rawConfig) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error("NODE_VERSION_UNSUPPORTED: proxy mode requires Node 24.15+ for durable SQLite");
  }
  // Snapshot caller-owned configuration so later mutation cannot change trust policy.
  const config = validConfig(JSON.parse(JSON.stringify(rawConfig)));
  const upstream = new Client({ name: "once-upstream-proxy", version: "0.1.0" });
  let downstream;
  let catalogInvalidated = false;
  upstream.setNotificationHandler("notifications/tools/list_changed", () => {
    catalogInvalidated = true;
  });
  try {
    await upstream.connect(new StdioClientTransport({
      command: config.command,
      args: config.args,
      ...(config.cwd ? { cwd: config.cwd } : {}),
    }));
    // Raw requests are authoritative for catalog integrity. Client.listTools()
    // in MCP client v2 auto-aggregates pages internally, so the proxy cannot
    // inspect pagination failures through that convenience API alone.
    const tools = await listCompleteCatalog(upstream);

    // Prime the SDK's tool cache so callTool() keeps output-schema validation,
    // then cross-check the cached aggregate against the raw authoritative walk.
    // If the SDK silently truncates pagination, fail closed rather than expose a
    // partial tool universe or validate results against an incomplete cache.
    const sdkCatalog = await upstream.listTools();
    if (catalogDigest(sdkCatalog.tools) !== catalogDigest(tools)) {
      throw new Error("INVALID_TOOL_CATALOG: SDK aggregate differs from raw catalog");
    }

    if (catalogDigest(tools) !== config.expectedCatalogSha256) {
      throw new Error("TOOL_SCHEMA_CHANGED: upstream catalog differs from reviewed configuration");
    }
    let catalogCheck;
    async function verifyCatalog() {
      if (catalogInvalidated) {
        throw new Error("TOOL_SCHEMA_CHANGED: upstream announced a catalog change");
      }
      // Verify before each dispatch; share an in-flight read across concurrent calls.
      catalogCheck ??= listCompleteCatalog(upstream).then(current => {
        if (catalogDigest(current) !== config.expectedCatalogSha256 || catalogInvalidated) {
          catalogInvalidated = true;
          throw new Error("TOOL_SCHEMA_CHANGED: upstream catalog differs from reviewed configuration");
        }
      }).finally(() => { catalogCheck = undefined; });
      await catalogCheck;
    }
    const boundary = createMcpExecutionBoundary({
      serverId: config.serverId,
      tools,
      statePath: resolve(config.statePath),
      overrides: config.tools,
      upstream: {
        async callTool({ name, arguments: args }) {
          const result = await upstream.callTool({ name, arguments: args });
          // An MCP isError result may arrive after an external write. Preserve UNKNOWN.
          if (result.isError) throw new Error("UPSTREAM_TOOL_ERROR: outcome ambiguous");
          return result;
        },
      },
    });
    const checkedBoundary = {
      listTools: () => boundary.listTools(),
      async callTool(request) {
        await verifyCatalog();
        return boundary.callTool(request);
      },
    };
    downstream = createMcpProxyServer({ boundary: checkedBoundary, version: "phase13b" });
    return {
      server: downstream,
      plan: boundary.plan,
      async close() {
        try { await downstream.close(); } finally { await upstream.close(); }
      },
    };
  } catch (error) {
    try { await downstream?.close(); } finally { await upstream.close(); }
    throw error;
  }
}

export async function runProxyCli(args = process.argv.slice(2)) {
  const index = args.indexOf("--config");
  if (index < 0 || !args[index + 1]) {
    console.error("Usage: once-mcp proxy --config .once/mcp.json");
    process.exitCode = 2;
  } else {
    try {
      const configPath = resolve(args[index + 1]);
      const config = JSON.parse(await readFile(configPath, "utf8"));
      // Relative state/cwd paths are anchored to the reviewed config file.
      const { dirname } = await import("node:path");
      const base = dirname(configPath);
      config.statePath = resolve(base, config.statePath);
      if (config.cwd) config.cwd = resolve(base, config.cwd);
      const proxy = await connectStdioProxy(config);
      console.error(`Once proxy connected: ${proxy.plan.entries.length} tools`);
      const handle = serveStdio(() => proxy.server);
      proxy.server.server.onclose = () => void proxy.close();
      process.once("SIGINT", () => void handle.close().finally(() => proxy.close()));
      process.once("SIGTERM", () => void handle.close().finally(() => proxy.close()));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runProxyCli();
}

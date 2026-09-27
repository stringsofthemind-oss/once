#!/usr/bin/env node
// Phase 13B source-tree prototype. Do not package until the SDK dependency is aligned.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpExecutionBoundary } from "../../sdk/typescript/dist/connect/index.js";
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

async function listCompleteCatalog(client) {
  const tools = [];
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    if (!Array.isArray(result.tools) || tools.length + result.tools.length > 1000) {
      throw new Error("INVALID_TOOL_CATALOG: tool limit exceeded");
    }
    tools.push(...result.tools);
    if (!result.nextCursor) return tools;
    if (seen.has(result.nextCursor)) throw new Error("INVALID_TOOL_CATALOG: cursor loop");
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("INVALID_TOOL_CATALOG: page limit exceeded");
}

export async function connectStdioProxy(rawConfig) {
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
    const tools = await listCompleteCatalog(upstream);
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf("--config");
  if (index < 0 || !process.argv[index + 1]) {
    console.error("Usage: node mcp/scripts/stdio-proxy.mjs --config .once/mcp.json");
    process.exitCode = 2;
  } else {
    try {
      const configPath = resolve(process.argv[index + 1]);
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

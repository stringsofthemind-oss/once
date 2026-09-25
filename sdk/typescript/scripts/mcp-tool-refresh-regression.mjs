import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  discoverToolGraph,
} from "../dist/tool-discovery.js";

import {
  discoverLiveMcpTools,
} from "../dist/mcp-live-discovery.js";

import {
  diffMcpToolSnapshots,
  rankMcpSourcePrecedence,
  watchMcpToolListOnce,
} from "../dist/mcp-tool-refresh.js";

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, payload, status = 200, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve("dist/cli.js"), ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ONCE_API_KEY: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

const root = await mkdtemp(
  path.join(os.tmpdir(), "once-phase11b-refresh-"),
);

let modernGeneration = 1;
let modernSubscriptions = 0;
let toolCalls = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const body = await readJson(req);
  const method = body.method;

  if (method === "tools/call") {
    toolCalls++;
    sendJson(res, {
      jsonrpc: "2.0",
      id: body.id,
      result: { content: [] },
    });
    return;
  }

  if (url.pathname === "/modern" || url.pathname === "/quiet") {
    if (method === "server/discover") {
      sendJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          serverInfo: {
            name: url.pathname === "/modern" ? "refresh-modern" : "refresh-quiet",
            version: "1.0.0",
          },
          capabilities: {
            tools: { listChanged: true },
          },
          supportedVersions: ["2026-07-28"],
        },
      });
      return;
    }

    if (method === "tools/list") {
      const tools =
        url.pathname === "/quiet"
          ? [
              {
                name: "search_quiet",
                description: "Search without mutation",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true },
              },
            ]
          : modernGeneration === 1
            ? [
                {
                  name: "search_web",
                  description: "Search the web",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true },
                },
                {
                  name: "send_email",
                  description: "Send an email v1",
                  inputSchema: {
                    type: "object",
                    properties: {
                      to: { type: "string" },
                    },
                  },
                },
              ]
            : [
                {
                  name: "send_email",
                  description: "Send an email v2",
                  inputSchema: {
                    type: "object",
                    properties: {
                      to: { type: "string" },
                      subject: { type: "string" },
                    },
                  },
                },
                {
                  name: "charge_customer",
                  description: "Charge a customer payment method",
                  inputSchema: { type: "object" },
                },
              ];

      sendJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: { tools },
      });
      return;
    }

    if (method === "subscriptions/listen") {
      assert.equal(req.headers["mcp-protocol-version"], "2026-07-28");
      assert.equal(req.headers["mcp-method"], "subscriptions/listen");
      assert.equal(body.params?.notifications?.toolsListChanged, true);
      assert.equal(
        body.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
        "2026-07-28",
      );

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      sendSse(res, {
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: {
          notifications: {
            toolsListChanged: true,
          },
          _meta: {
            "io.modelcontextprotocol/subscriptionId": body.id,
          },
        },
      });

      if (url.pathname === "/modern") {
        modernSubscriptions++;
        setTimeout(() => {
          modernGeneration++;
          if (!res.destroyed) {
            sendSse(res, {
              jsonrpc: "2.0",
              method: "notifications/tools/list_changed",
              params: {
                _meta: {
                  "io.modelcontextprotocol/subscriptionId": body.id,
                },
              },
            });
          }
        }, 25);
      }

      req.on("close", () => {
        if (!res.writableEnded) res.end();
      });
      return;
    }
  }

  if (url.pathname === "/legacy") {
    if (method === "server/discover") {
      sendJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32601,
          message: "Method not found",
        },
      });
      return;
    }

    if (method === "initialize") {
      sendJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-11-25",
          serverInfo: { name: "legacy", version: "1" },
          capabilities: { tools: { listChanged: true } },
        },
      }, 200, {
        "Mcp-Session-Id": "legacy-refresh-session",
      });
      return;
    }

    if (method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }

    if (method === "tools/list") {
      sendJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "legacy_tool",
              description: "Legacy tool",
              inputSchema: { type: "object" },
            },
          ],
        },
      });
      return;
    }
  }

  sendJson(res, {
    jsonrpc: "2.0",
    id: body.id ?? null,
    error: {
      code: -32601,
      message: "Method not found",
    },
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  await mkdir(path.join(root, ".cursor"), { recursive: true });
  await writeFile(
    path.join(root, ".cursor", "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          modern: { url: `${base}/modern` },
          quiet: { url: `${base}/quiet` },
          legacy: { url: `${base}/legacy` },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const discovery = await discoverToolGraph(root);

  const initialModern = await discoverLiveMcpTools(
    root,
    discovery.configuredSources,
    ["cursor/modern"],
  );
  assert.deepEqual(
    initialModern.tools.map(tool => tool.canonicalName).sort(),
    ["search_web", "send_email"],
  );

  const refreshed = await watchMcpToolListOnce(
    root,
    discovery.configuredSources,
    "cursor/modern",
    initialModern,
    { watchMs: 500 },
  );

  assert.equal(refreshed.status, "CHANGED");
  assert.equal(refreshed.acknowledged, true);
  assert.equal(refreshed.changeNotificationReceived, true);
  assert.equal(refreshed.beforeCount, 2);
  assert.equal(refreshed.afterCount, 2);
  assert.deepEqual(refreshed.diff.added, ["cursor/modern/charge_customer"]);
  assert.deepEqual(refreshed.diff.removed, ["cursor/modern/search_web"]);
  assert.deepEqual(refreshed.diff.changed, ["cursor/modern/send_email"]);
  assert.equal(modernSubscriptions, 1);
  assert.equal(toolCalls, 0);

  const quietInitial = await discoverLiveMcpTools(
    root,
    discovery.configuredSources,
    ["cursor/quiet"],
  );
  const quiet = await watchMcpToolListOnce(
    root,
    discovery.configuredSources,
    "cursor/quiet",
    quietInitial,
    { watchMs: 80 },
  );
  assert.equal(quiet.status, "NO_CHANGE");
  assert.equal(quiet.acknowledged, true);
  assert.equal(quiet.changeNotificationReceived, false);
  assert.deepEqual(quiet.diff, {
    added: [],
    removed: [],
    changed: [],
  });

  const legacyInitial = await discoverLiveMcpTools(
    root,
    discovery.configuredSources,
    ["cursor/legacy"],
  );
  const legacy = await watchMcpToolListOnce(
    root,
    discovery.configuredSources,
    "cursor/legacy",
    legacyInitial,
    { watchMs: 100 },
  );
  assert.equal(legacy.status, "UNSUPPORTED_LEGACY");
  assert.equal(
    legacy.errorCode,
    "LEGACY_CHANGE_STREAM_NOT_SUPPORTED_IN_11B_V1",
  );

  const duplicateBefore = [
    {
      ...initialModern.tools[0],
      canonicalName: "same_name",
      origin: {
        ...initialModern.tools[0].origin,
        server: "server-a",
      },
    },
  ];
  const duplicateAfter = [
    {
      ...initialModern.tools[0],
      canonicalName: "same_name",
      origin: {
        ...initialModern.tools[0].origin,
        server: "server-b",
      },
    },
  ];
  const namespaceDiff = diffMcpToolSnapshots(duplicateBefore, duplicateAfter);
  assert.deepEqual(namespaceDiff.added, ["cursor/server-b/same_name"]);
  assert.deepEqual(namespaceDiff.removed, ["cursor/server-a/same_name"]);

  const precedence = rankMcpSourcePrecedence([
    {
      sourceId: "user",
      kind: "MCP_SERVER",
      host: "cursor",
      name: "docs",
      scope: "USER",
      configPath: "~/.cursor/mcp.json",
      transport: "HTTP",
      evidence: "HOST_CONFIGURED",
      status: "CONFIGURED_NOT_PROBED",
    },
    {
      sourceId: "project",
      kind: "MCP_SERVER",
      host: "cursor",
      name: "docs",
      scope: "PROJECT",
      configPath: ".cursor/mcp.json",
      transport: "HTTP",
      evidence: "HOST_CONFIGURED",
      status: "CONFIGURED_NOT_PROBED",
    },
  ]);
  assert.equal(precedence[0].sourceId, "project");
  assert.equal(precedence[1].sourceId, "user");

  modernGeneration = 1;
  const cli = await runCli([
    "doctor",
    root,
    "--tools",
    "--tools-live=cursor/modern",
    "--tools-watch-ms=500",
  ]);
  assert.equal(
    cli.code,
    0,
    `watch CLI failed\nstdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`,
  );
  assert.match(cli.stdout, /MCP TOOL LIST REFRESH/);
  assert.match(cli.stdout, /Status: CHANGED/);
  assert.match(cli.stdout, /cursor\/modern\/charge_customer/);
  assert.match(cli.stdout, /cursor\/modern\/search_web/);
  assert.match(cli.stdout, /cursor\/modern\/send_email/);
  assert.equal(toolCalls, 0);

  const invalidCli = await runCli([
    "doctor",
    root,
    "--tools",
    "--tools-watch-ms=100",
  ]);
  assert.notEqual(invalidCli.code, 0);
  assert.match(
    invalidCli.stderr,
    /requires exactly one --tools-live/,
  );

  console.log("mcp tool refresh regression: PASS");
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

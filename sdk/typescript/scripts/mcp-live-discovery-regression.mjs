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
  McpLiveDiscoveryError,
  discoverLiveMcpTools,
} from "../dist/mcp-live-discovery.js";

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

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve("dist/cli.js"), ...args],
      {
        cwd,
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
    child.on("close", code => {
      resolve({ code, stdout, stderr });
    });
  });
}

const root = await mkdtemp(
  path.join(os.tmpdir(), "once-phase11b-"),
);

let requestCount = 0;
let redirectedTargetHits = 0;
let modernAuthorizationSeen = false;
let legacyInitializedSeen = false;
let legacySessionSeen = false;

const server = http.createServer(async (req, res) => {
  requestCount++;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/should-not-hit") {
    redirectedTargetHits++;
    sendJson(res, { ok: true });
    return;
  }

  if (url.pathname === "/redirect") {
    res.writeHead(302, {
      location: "/should-not-hit",
    });
    res.end();
    return;
  }

  if (url.pathname === "/slow") {
    await new Promise(resolve => setTimeout(resolve, 180));
    sendJson(res, {
      jsonrpc: "2.0",
      id: "once-discover-1",
      result: {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
      },
    });
    return;
  }

  const body = await readJson(req);
  const method = body.method;

  if (url.pathname === "/modern") {
    if (req.headers.authorization === "Bearer fixture-secret") {
      modernAuthorizationSeen = true;
    }

    if (method === "server/discover") {
      assert.equal(req.headers["mcp-protocol-version"], "2026-07-28");
      assert.equal(req.headers["mcp-method"], "server/discover");
      assert.equal(
        body.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
        "2026-07-28",
      );

      sendJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          serverInfo: {
            name: "fixture-modern",
            version: "1.0.0",
          },
          capabilities: {
            tools: { listChanged: true },
          },
          supportedVersions: ["2026-07-28", "2025-11-25"],
        },
      });
      return;
    }

    if (method === "tools/list") {
      assert.equal(req.headers["mcp-protocol-version"], "2026-07-28");
      assert.equal(req.headers["mcp-method"], "tools/list");
      assert.equal(
        body.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
        "2026-07-28",
      );

      if (!body.params?.cursor) {
        sendJson(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "search_web",
                description: "Search the public web",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                  },
                },
                annotations: {
                  readOnlyHint: true,
                },
              },
            ],
            nextCursor: "page-2",
          },
        });
        return;
      }

      assert.equal(body.params.cursor, "page-2");
      sendJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "charge_customer",
              description: "Charge a customer payment method",
              inputSchema: {
                type: "object",
              },
            },
          ],
        },
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
      assert.equal(req.headers["mcp-protocol-version"], "2025-11-25");
      sendJson(
        res,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: {
              name: "fixture-legacy",
              version: "1.0.0",
            },
            capabilities: {
              tools: {},
            },
          },
        },
        200,
        {
          "Mcp-Session-Id": "legacy-session-1",
        },
      );
      return;
    }

    if (method === "notifications/initialized") {
      legacyInitializedSeen = true;
      legacySessionSeen =
        req.headers["mcp-session-id"] === "legacy-session-1";
      res.writeHead(202);
      res.end();
      return;
    }

    if (method === "tools/list") {
      legacySessionSeen =
        legacySessionSeen &&
        req.headers["mcp-session-id"] === "legacy-session-1";
      sendJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "send_email",
              description: "Send an external email message",
              inputSchema: {
                type: "object",
              },
            },
          ],
        },
      });
      return;
    }
  }

  sendJson(
    res,
    {
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: {
        code: -32601,
        message: "Method not found",
      },
    },
  );
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
          modern: {
            url: `${base}/modern?token=query-secret-must-not-leak`,
            headers: {
              Authorization: "Bearer fixture-secret",
            },
          },
          legacy: {
            url: `${base}/legacy`,
          },
          redirect: {
            url: `${base}/redirect`,
          },
          slow: {
            url: `${base}/slow`,
          },
          local_stdio: {
            command: "node",
            args: ["definitely-do-not-launch.js"],
            env: {
              SECRET: "stdio-secret-must-not-leak",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const discovery = await discoverToolGraph(root);
  assert.equal(discovery.configuredSources.length, 5);

  await assert.rejects(
    () => discoverLiveMcpTools(root, discovery.configuredSources, []),
    error =>
      error instanceof McpLiveDiscoveryError &&
      error.code === "EXPLICIT_SELECTION_REQUIRED",
  );

  const result = await discoverLiveMcpTools(
    root,
    discovery.configuredSources,
    [
      "cursor/modern",
      "cursor/legacy",
      "cursor/local_stdio",
      "cursor/redirect",
      "cursor/slow",
    ],
    {
      timeoutMs: 60,
      maxPages: 4,
      maxTools: 20,
    },
  );

  assert.equal(result.mode, "EXPLICIT_REMOTE_HTTP");
  assert.equal(result.externalServersContacted, 4);
  assert.equal(result.stdioServersLaunched, false);
  assert.equal(result.redirectsFollowed, false);
  assert.equal(result.secretValuesRetained, false);
  assert.equal(redirectedTargetHits, 0);
  assert.equal(modernAuthorizationSeen, true);
  assert.equal(legacyInitializedSeen, true);
  assert.equal(legacySessionSeen, true);

  const modern = result.probes.find(
    probe => probe.source === "cursor/modern",
  );
  assert.ok(modern);
  assert.equal(modern.status, "ENUMERATED");
  assert.equal(modern.protocolEra, "MODERN_2026");
  assert.equal(modern.protocolVersion, "2026-07-28");
  assert.equal(modern.pages, 2);
  assert.equal(modern.toolCount, 2);
  assert.equal(modern.endpoint, `${base}/modern`);

  const legacy = result.probes.find(
    probe => probe.source === "cursor/legacy",
  );
  assert.ok(legacy);
  assert.equal(legacy.status, "ENUMERATED");
  assert.equal(legacy.protocolEra, "LEGACY_2025");
  assert.equal(legacy.protocolVersion, "2025-11-25");
  assert.equal(legacy.toolCount, 1);

  const stdio = result.probes.find(
    probe => probe.source === "cursor/local_stdio",
  );
  assert.ok(stdio);
  assert.equal(stdio.status, "SKIPPED_STDIO");

  const redirect = result.probes.find(
    probe => probe.source === "cursor/redirect",
  );
  assert.ok(redirect);
  assert.equal(redirect.status, "FAILED");
  assert.equal(redirect.errorCode, "REDIRECT_BLOCKED");

  const slow = result.probes.find(
    probe => probe.source === "cursor/slow",
  );
  assert.ok(slow);
  assert.equal(slow.status, "FAILED");
  assert.equal(slow.errorCode, "TIMEOUT");

  assert.deepEqual(
    result.tools.map(tool => tool.canonicalName).sort(),
    ["charge_customer", "search_web", "send_email"],
  );

  const search = result.tools.find(tool => tool.canonicalName === "search_web");
  assert.ok(search);
  assert.equal(search.evidence.level, "SERVER_AUTHORITATIVE");
  assert.equal(search.once.effectClass, "READ_ONLY");
  assert.equal(search.once.actionPriority.band, "BYPASS");

  const charge = result.tools.find(tool => tool.canonicalName === "charge_customer");
  assert.ok(charge);
  assert.equal(charge.evidence.level, "SERVER_AUTHORITATIVE");
  assert.equal(charge.once.effectClass, "MONEY_MOVEMENT");
  assert.ok(
    ["PROTECT_PRIORITY", "CRITICAL_GAP"].includes(
      charge.once.actionPriority.band,
    ),
  );

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /fixture-secret/);
  assert.doesNotMatch(serialized, /query-secret-must-not-leak/);
  assert.doesNotMatch(serialized, /stdio-secret-must-not-leak/);
  assert.doesNotMatch(serialized, /Authorization/i);

  const requestsBeforeOfflineDoctor = requestCount;
  const offline = await runCli(
    ["doctor", root, "--tools"],
    process.cwd(),
  );
  assert.equal(
    offline.code,
    0,
    `offline doctor failed\nstdout:\n${offline.stdout}\nstderr:\n${offline.stderr}`,
  );
  assert.equal(
    requestCount,
    requestsBeforeOfflineDoctor,
    "plain doctor --tools must remain offline",
  );
  assert.match(offline.stdout, /External MCP servers contacted: no/);
  assert.doesNotMatch(offline.stdout, /fixture-secret/);

  const live = await runCli(
    [
      "doctor",
      root,
      "--tools",
      "--tools-live=cursor/modern",
    ],
    process.cwd(),
  );
  assert.equal(
    live.code,
    0,
    `live doctor failed\nstdout:\n${live.stdout}\nstderr:\n${live.stderr}`,
  );
  assert.match(live.stdout, /LIVE MCP TOOL ENUMERATION/);
  assert.match(live.stdout, /MODERN_2026\/2026-07-28/);
  assert.match(live.stdout, /SERVER-AUTHORITATIVE TOOLS/);
  assert.match(live.stdout, /search_web/);
  assert.match(live.stdout, /charge_customer/);
  assert.doesNotMatch(live.stdout, /fixture-secret/);
  assert.doesNotMatch(live.stdout, /query-secret-must-not-leak/);

  console.log("mcp live discovery regression: PASS");
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

import { McpServer } from "@modelcontextprotocol/server";

export interface McpProxyToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpProxyBoundary<Result = unknown> {
  listTools(): Readonly<{ tools: readonly McpProxyToolDescriptor[] }>;
  callTool(request: Readonly<{
    name: string;
    arguments?: Record<string, unknown>;
    requestId?: unknown;
  }>): Promise<Result>;
}

export interface McpProxyServerOptions<Result = unknown> {
  boundary: McpProxyBoundary<Result>;
  name?: string;
  version?: string;
}

export class McpProxyServerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "McpProxyServerError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Build the downstream MCP server side of the Once execution choke point.
 *
 * This adapter deliberately contains no routing, identity, replay, conflict or
 * reconciliation logic. Those semantics belong to the injected boundary. Its
 * only job is to make the boundary the physical `tools/list` + `tools/call`
 * crossing seen by an MCP client.
 */
export function createMcpProxyServer<Result = unknown>(
  options: McpProxyServerOptions<Result>,
): McpServer {
  if (
    !options?.boundary ||
    typeof options.boundary.listTools !== "function" ||
    typeof options.boundary.callTool !== "function"
  ) {
    throw new McpProxyServerError(
      "INVALID_BOUNDARY",
      "Once MCP proxy requires a connected execution boundary.",
    );
  }

  const server = new McpServer(
    {
      name: options.name?.trim() || "once-mcp-proxy",
      version: options.version?.trim() || "phase13a",
      description:
        "Fail-closed MCP tool execution proxy backed by Once execution safety.",
    },
    {
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
    },
  );

  server.server.setRequestHandler("tools/list", async () => {
    const listed = options.boundary.listTools();

    if (!listed || !Array.isArray(listed.tools)) {
      throw new McpProxyServerError(
        "INVALID_TOOL_CATALOG",
        "Once MCP boundary returned an invalid tools/list catalog.",
      );
    }

    // The boundary owns catalog validation and provenance. The MCP SDK owns
    // wire validation, so preserve the authoritative descriptors unchanged.
    return {
      tools: [...listed.tools],
    } as never;
  });

  server.server.setRequestHandler("tools/call", async (request, ctx) => {
    const params = request.params;

    if (
      !params ||
      typeof params.name !== "string" ||
      params.name.trim().length === 0
    ) {
      throw new McpProxyServerError(
        "INVALID_TOOL_CALL",
        "Downstream MCP tools/call is missing a stable tool name.",
      );
    }

    if (
      params.arguments !== undefined &&
      !isRecord(params.arguments)
    ) {
      throw new McpProxyServerError(
        "INVALID_TOOL_ARGUMENTS",
        "Downstream MCP tools/call arguments must be a plain object.",
      );
    }

    const result = await options.boundary.callTool({
      name: params.name,
      ...(params.arguments !== undefined
        ? { arguments: params.arguments }
        : {}),
      // Transport correlation is forwarded only so the boundary can prove it
      // is ignored for logical-operation identity.
      requestId: ctx.mcpReq.id,
    });

    return result as never;
  });

  return server;
}

import type {
  McpAuthoritativeToolRecord,
  McpLiveDiscoveryResult,
} from "./mcp-live-discovery.js";

function printTool(tool: McpAuthoritativeToolRecord): void {
  const priority = tool.once.actionPriority.score
    .toString()
    .padStart(3, " ");

  console.log(
    `  ${priority}  ${tool.once.criticality.band}  ${tool.canonicalName}  SERVER_AUTHORITATIVE  ${tool.once.qualification}`,
  );
  console.log(
    `       ${tool.once.effectClass} · ${tool.origin.host}/${tool.origin.server}`,
  );
}

export function printMcpLiveDiscoveryReport(
  result: McpLiveDiscoveryResult,
): void {
  console.log("");
  console.log("LIVE MCP TOOL ENUMERATION");
  console.log("-------------------------");
  console.log("Mode: explicit remote HTTP read-only enumeration");
  console.log(
    `External MCP servers contacted: ${result.externalServersContacted}`,
  );
  console.log("Unknown local stdio commands launched: no");
  console.log("Redirects followed: no");
  console.log("Secret values retained: no");

  if (result.probes.length === 0) {
    console.log("No selected configured MCP servers were probed.");
    return;
  }

  console.log("");
  console.log("PROBE RESULTS");
  console.log("-------------");

  for (const probe of result.probes) {
    const protocol = probe.protocolEra
      ? ` ${probe.protocolEra}/${probe.protocolVersion ?? "unknown"}`
      : "";
    const error = probe.errorCode
      ? ` ${probe.errorCode}`
      : "";

    console.log(
      `  ${probe.source}  ${probe.status}${protocol}  tools=${probe.toolCount} pages=${probe.pages}${error}`,
    );

    if (probe.endpoint) {
      console.log(`       ${probe.endpoint}`);
    }
  }

  if (result.tools.length === 0) {
    console.log("");
    console.log("No authoritative tools were returned by the selected servers.");
    return;
  }

  console.log("");
  console.log("SERVER-AUTHORITATIVE TOOLS");
  console.log("--------------------------");

  for (const tool of result.tools) {
    printTool(tool);
  }

  console.log("");
  console.log(
    "Live enumeration observes tool definitions only. It does not call tools, authorize execution, launch stdio servers, or automatically apply Once protection.",
  );
}

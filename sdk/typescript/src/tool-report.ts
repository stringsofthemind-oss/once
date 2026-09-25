import type {
  ConfiguredToolSource,
  ToolDiscoveryResult,
  ToolGraphRecord
} from "./tool-discovery.js";

function printConfiguredSource(
  source: ConfiguredToolSource
): void {
  console.log(
    `  ${source.scope.padEnd(7)} ${source.host}/${source.name}  ${source.transport}  ${source.status}`
  );
  console.log(
    `           ${source.configPath}`
  );
}

function printTool(
  tool: ToolGraphRecord
): void {
  const priority =
    tool.once.actionPriority.score
      .toString()
      .padStart(3, " ");

  const importance =
    tool.once.criticality.band;

  console.log(
    `  ${priority}  ${importance}  ${tool.canonicalName}  ${tool.evidence.level}  ${tool.once.qualification}`
  );
  console.log(
    `       ${tool.once.effectClass} · ${tool.source.file}${tool.source.line ? `:${tool.source.line}` : ""}`
  );
}

function section(
  title: string,
  tools: ToolGraphRecord[]
): void {
  if (tools.length === 0) {
    return;
  }

  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));

  for (const tool of tools) {
    printTool(tool);
  }
}

export function printToolDiscoveryReport(
  result: ToolDiscoveryResult
): void {
  console.log("");
  console.log("TOOL DISCOVERY");
  console.log("--------------");
  console.log("Mode: local + read-only");
  console.log("External MCP servers contacted: no");
  console.log("Unknown local server commands launched: no");
  console.log("Secret values retained: no");
  console.log(
    `Configured MCP sources: ${result.configuredSources.length}`
  );
  console.log(
    `Source-discovered tools/capabilities: ${result.tools.length}`
  );

  if (result.configuredSources.length > 0) {
    console.log("");
    console.log("CONFIGURED TOOL SOURCES");
    console.log("-----------------------");

    for (const source of result.configuredSources) {
      printConfiguredSource(source);
    }

    console.log("");
    console.log(
      "Configured servers are not treated as authoritative tool inventories until a later trusted tools/list probe."
    );
  }

  console.log("");
  console.log("TOOL SAFETY PRIORITY");
  console.log("--------------------");

  if (result.tools.length === 0) {
    console.log(
      "No source-level tool or consequential-operation candidates were discovered."
    );
    console.log(
      "This does not prove the environment has no tools; runtime and authoritative MCP discovery are later phases."
    );
    return;
  }

  const criticalGaps =
    result.tools.filter(
      tool =>
        !tool.once.protectedCritical &&
        tool.once.actionPriority.band === "CRITICAL_GAP"
    );

  const highPriority =
    result.tools.filter(
      tool =>
        !tool.once.protectedCritical &&
        tool.once.actionPriority.band === "PROTECT_PRIORITY"
    );

  const qualify =
    result.tools.filter(
      tool =>
        !tool.once.protectedCritical &&
        tool.once.actionPriority.band === "QUALIFY"
    );

  const review =
    result.tools.filter(
      tool =>
        !tool.once.protectedCritical &&
        tool.once.actionPriority.band === "REVIEW"
    );

  const observe =
    result.tools.filter(
      tool =>
        !tool.once.protectedCritical &&
        tool.once.actionPriority.band === "OBSERVE"
    );

  const bypass =
    result.tools.filter(
      tool =>
        !tool.once.protectedCritical &&
        tool.once.actionPriority.band === "BYPASS"
    );

  const protectedCritical =
    result.tools.filter(
      tool => tool.once.protectedCritical
    );

  section("CRITICAL GAPS", criticalGaps);
  section("HIGH PRIORITY", highPriority);
  section("QUALIFY", qualify);
  section("REVIEW", review);
  section("OBSERVE", observe);
  section("BYPASS / READ-ONLY", bypass);
  section("PROTECTED CRITICAL", protectedCritical);

  console.log("");
  console.log(
    "Importance orders attention only. It does not authorize execution or protection. The Once four-condition test remains the qualification gate."
  );
}

import type {
  McpToolRefreshResult,
} from "./mcp-tool-refresh.js";

export function printMcpToolRefreshReport(
  result: McpToolRefreshResult,
): void {
  console.log("");
  console.log("MCP TOOL LIST REFRESH");
  console.log("---------------------");
  console.log(`Source: ${result.source}`);
  console.log(`Namespace: ${result.namespace}`);
  console.log(`Watch window: ${result.watchMs} ms`);
  console.log(`Status: ${result.status}`);
  console.log(
    `Subscription acknowledged: ${result.acknowledged ? "yes" : "no"}`,
  );
  console.log(
    `Tool-list change received: ${result.changeNotificationReceived ? "yes" : "no"}`,
  );
  console.log(
    `Tool count: ${result.beforeCount} -> ${result.afterCount}`,
  );

  if (result.errorCode) {
    console.log(`Reason: ${result.errorCode}`);
  }

  if (result.status !== "CHANGED") {
    console.log("");
    console.log(
      "No authoritative tool snapshot was replaced. Watching is bounded and does not continue in the background.",
    );
    return;
  }

  const groups = [
    ["ADDED", result.diff.added],
    ["REMOVED", result.diff.removed],
    ["CHANGED", result.diff.changed],
  ] as const;

  for (const [title, names] of groups) {
    if (names.length === 0) continue;
    console.log("");
    console.log(title);
    console.log("-".repeat(title.length));
    for (const name of names) {
      console.log(`  ${name}`);
    }
  }

  if (
    result.diff.added.length === 0 &&
    result.diff.removed.length === 0 &&
    result.diff.changed.length === 0
  ) {
    console.log("");
    console.log(
      "The server signaled a tool-list change, but the refreshed authoritative snapshot is semantically unchanged.",
    );
  }

  console.log("");
  console.log(
    "Refresh re-runs tools/list only. It does not invoke any MCP tool or apply protection automatically.",
  );
}

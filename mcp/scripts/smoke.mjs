import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const expectedTools = [
  "once_assess_project",
  "once_explain_risk",
  "once_plan_setup",
  "once_setup_project",
  "once_plan_protection",
  "once_apply_protection",
  "once_verify_connection",
  "once_live_proof"
];

const client = new Client({
  name: "once-mcp-smoke",
  version: "0.1.0"
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"]
});

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name).sort();

  for (const expected of expectedTools) {
    if (!names.includes(expected)) {
      throw new Error(`Missing MCP tool: ${expected}`);
    }
  }

  const assessment = await client.callTool({
    name: "once_assess_project",
    arguments: {
      projectPath: process.cwd(),
      includeEstimates: false
    }
  });

  if (assessment.isError) {
    throw new Error(
      `once_assess_project returned isError=true: ${JSON.stringify(assessment.content)}`
    );
  }

  const risk = await client.callTool({
    name: "once_explain_risk",
    arguments: {
      operation: "Issue a customer refund",
      retryScenario: "The provider accepted the refund but the response timed out"
    }
  });

  if (risk.isError) {
    throw new Error("once_explain_risk returned isError=true");
  }

  const proof = await client.callTool({
    name: "once_live_proof",
    arguments: {}
  });

  if (proof.isError) {
    throw new Error("once_live_proof returned isError=true");
  }

  console.log("ONCE MCP SMOKE: PASS");
  console.log(`Tools discovered: ${names.length}`);
  console.log(names.join("\n"));
} finally {
  await client.close();
}

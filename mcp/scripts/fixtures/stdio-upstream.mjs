import { appendFileSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const tools = JSON.parse(await readFile(new URL("./stdio-tools.json", import.meta.url), "utf8"));
const effectsPath = process.argv[2];
if (!effectsPath) throw new Error("Missing disposable effects file");
const server = new McpServer({ name: "once-disposable-upstream", version: "0.0.1" },
  { capabilities: { tools: { listChanged: false } } });
server.server.setRequestHandler("tools/list", async () => ({ tools }));
server.server.setRequestHandler("tools/call", async request => {
  const { name, arguments: args = {} } = request.params;
  if (name === "read_count") {
    let count = 0;
    try { count = readFileSync(effectsPath, "utf8").trim().split("\n").filter(Boolean).length; } catch {}
    return { content: [{ type: "text", text: String(count) }] };
  }
  if (name !== "create_order") throw new Error("Unknown tool");
  appendFileSync(effectsPath, JSON.stringify(args) + "\n");
  if (args.sku === "lost-ack") throw new Error("Acknowledgement lost after disposable write");
  return { content: [{ type: "text", text: "created:" + args.operation_id }] };
});
serveStdio(() => server);

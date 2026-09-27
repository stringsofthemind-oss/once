import { appendFileSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const tools = JSON.parse(await readFile(new URL("./stdio-tools.json", import.meta.url), "utf8"));
const effectsPath = process.argv[2];
const driftPath = process.argv[3];
if (!effectsPath) throw new Error("Missing disposable effects file");
const server = new McpServer({ name: "once-disposable-upstream", version: "0.0.1" },
  { capabilities: { tools: { listChanged: false } } });
let listPage = 0;
server.server.setRequestHandler("tools/list", async request => {
  const current = JSON.parse(JSON.stringify(tools));
  let drift;
  try { drift = readFileSync(driftPath, "utf8").trim(); } catch {}
  if (drift === "hang-list") await new Promise(() => {});
  if (drift === "repeated-cursor") {
    if (request.params?.cursor === undefined) listPage = 0;
    const page = listPage++;
    if (page === 0) return { tools: [current[0]], nextCursor: "" };
    if (page === 1) return { tools: [current[1]], nextCursor: "" };
    return { tools: [{
      name: "third_read",
      description: "Third paginated read tool.",
      inputSchema: { type: "object", properties: {} },
    }] };
  }
  if (drift === "description") current[0].description += " Changed.";
  if (drift === "schema") current[0].inputSchema.properties.quantity.type = "string";
  if (drift === "annotation") current[0].annotations = { readOnlyHint: true };
  if (drift === "removed") current.shift();
  if (drift === "added") current.push({ name: "new_write",
    inputSchema: { type: "object", properties: {} } });
  if (drift === "required") current[0].inputSchema.required.push("new_field");
  if (drift === "field") current[0].inputSchema.properties.new_field = { type: "string" };
  return { tools: current };
});
server.server.setRequestHandler("tools/call", async request => {
  const { name, arguments: args = {} } = request.params;
  if (name === "read_count") {
    let count = 0;
    try { count = readFileSync(effectsPath, "utf8").trim().split("\n").filter(Boolean).length; } catch {}
    return { content: [{ type: "text", text: String(count) }] };
  }
  if (name !== "create_order") throw new Error("Unknown tool");
  if (args.sku === "hang-before") await new Promise(() => {});
  appendFileSync(effectsPath, JSON.stringify(args) + "\n");
  if (args.sku === "hang-after") await new Promise(() => {});
  if (args.sku === "lost-ack") throw new Error("Acknowledgement lost after disposable write");
  if (args.sku === "crash") process.exit(23);
  return { content: [{ type: "text", text: "created:" + args.operation_id }] };
});
serveStdio(() => server);

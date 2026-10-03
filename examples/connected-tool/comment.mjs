import { protectToolCall } from "../../sdk/typescript/dist/index.js";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The real host injects connected app/MCP functions. Credentials stay with it.
export async function postProtectedComment({ host, operationId, args, statePath, metadata }) {
  return protectToolCall({
    operationId,
    effect: { tool: `github.${host.authorityId}.add_comment`, args },
    statePath,
    metadata,
    execute: ({ args }) => host.addComment(args),
    reconcile: ({ effect }) => host.findMatchingComment(effect.args),
  });
}

async function demo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "once-connected-demo-"));
  const effectsPath = path.join(dir, "comments.json");
  writeFileSync(effectsPath, "[]");
  const comments = () => JSON.parse(readFileSync(effectsPath, "utf8"));
  const host = {
    authorityId: "disposable-simulation",
    async addComment(args) {
      const receipt = { id: comments().length + 1, ...args };
      writeFileSync(effectsPath, JSON.stringify([...comments(), receipt]));
      return receipt;
    },
    async findMatchingComment(args) {
      const found = comments().filter(c => c.repo === args.repo && c.issue === args.issue && c.body === args.body);
      return found.length === 1 ? { status: "CONFIRMED", result: found[0] } : { status: "UNKNOWN" };
    },
  };
  const call = { host, operationId: "disposable-comment-001", args: { repo: "owner/disposable-lab", issue: 217, body: "Simulated connected-tool test" }, statePath: path.join(dir, "once.sqlite") };
  try {
    console.log("first", await postProtectedComment(call));
    console.log("retry", await postProtectedComment({ ...call, metadata: { traceId: "new" } }));
    console.log("host effect count", comments().length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await demo();

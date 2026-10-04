import { stat } from "node:fs/promises";
import path from "node:path";
import { collectSourceFiles, scanFile } from "./scan.js";

export async function runFirst10Check(args: string[]) {
  if (args.length > 1 || args.some(arg => arg.startsWith("-"))) throw new Error("Usage: once check [directory]. Read-only; no apply options.");
  const root = path.resolve(args[0] ?? ".");
  if (!(await stat(root)).isDirectory()) throw new Error("once check needs a directory.");
  const files = await collectSourceFiles(root);
  console.log("ONCE CHECK — local, read-only candidate scan\nHeuristics can miss writes or flag harmless calls. No source uploaded or changed.");
  let count = 0;
  for (const file of files) {
    for (const finding of await scanFile(root, file)) {
      count++;
      console.log(`\nPotential consequential operation: ${finding.functionName ?? "call site"}\nLocation: ${finding.file}:${finding.line}\nWhy flagged: ${finding.reason}\nDetection confidence: ${finding.confidence.toLowerCase()} (not a safety verdict)\nReview: Can this call be retried? Could its outcome be uncertain? Would a duplicate matter?\nLogical identity and complete effect fields: not established by this scan. Developer review required.\nNext action: wrap the reviewed callback with wrapTool; see https://onceexec.com/quickstart/\nFirst, run: once prove`);
    }
  }
  console.log(`\n${count} candidates in ${files.length} files (scanner limit: 5000 files). No findings does not establish safety.\nIf provider idempotency or a database constraint fully solves the operation, use it.\nExisting detailed assessment remains available: once doctor [directory]`);
}

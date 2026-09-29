import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

const sourcePath = "scripts/cold-user-http-guidance-bootstrap-v2.mjs";
let source = await fs.readFile(sourcePath, "utf8");

const guidanceNeedle = `    lines.push(\`\`);\n    return lines.join("\\\\n");`;
const guidanceReplacement = `    lines.push(\n      \`Do not replace the original call until Once reports a supported protected path.\`,\n      \`\`\n    );\n    return lines.join("\\\\n");`;

if (!source.includes(guidanceNeedle)) {
  throw new Error("Expected provider-mapping snippet return was not found");
}
source = source.replace(guidanceNeedle, guidanceReplacement);

const cleanupNeedle = `await fs.rm("scripts/cold-user-http-guidance-bootstrap-v2.mjs", { force: true });\nawait fs.rm(".github/workflows/cold-user-http-guidance-bootstrap.yml", { force: true });`;
const cleanupReplacement = `await fs.rm("scripts/cold-user-http-guidance-bootstrap-v2.mjs", { force: true });\nawait fs.rm("scripts/cold-user-http-guidance-bootstrap-v3.mjs", { force: true });\nawait fs.rm(".github/workflows/cold-user-http-guidance-bootstrap.yml", { force: true });`;

if (!source.includes(cleanupNeedle)) {
  throw new Error("Expected bootstrap cleanup block was not found");
}
source = source.replace(cleanupNeedle, cleanupReplacement);

delete process.env.GITHUB_REF_NAME;

const tempPath = "/tmp/cold-user-http-guidance-bootstrap-v3-run.mjs";
await fs.writeFile(tempPath, source, "utf8");
await import(pathToFileURL(tempPath).href + `?run=${Date.now()}`);

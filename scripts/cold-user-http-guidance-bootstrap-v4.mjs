import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

const sourcePath = "scripts/cold-user-http-guidance-bootstrap-v2.mjs";
let source = await fs.readFile(sourcePath, "utf8");

const guidanceNeedle = String.raw`    lines.push(\`\`);\n    return lines.join("\\n");`;
const guidanceReplacement = String.raw`    lines.push(\n      \`Do not replace the original call until Once reports a supported protected path.\`,\n      \`\`\n    );\n    return lines.join("\\n");`;

const guidanceIndex = source.indexOf(guidanceNeedle);
if (guidanceIndex < 0 || source.indexOf(guidanceNeedle, guidanceIndex + guidanceNeedle.length) !== -1) {
  throw new Error("Expected exactly one provider-mapping snippet return");
}
source = source.slice(0, guidanceIndex) + guidanceReplacement + source.slice(guidanceIndex + guidanceNeedle.length);

const cleanupNeedle = String.raw`await fs.rm("scripts/cold-user-http-guidance-bootstrap-v2.mjs", { force: true });\nawait fs.rm(".github/workflows/cold-user-http-guidance-bootstrap.yml", { force: true });`;
const cleanupReplacement = String.raw`await fs.rm("scripts/cold-user-http-guidance-bootstrap-v2.mjs", { force: true });\nawait fs.rm("scripts/cold-user-http-guidance-bootstrap-v3.mjs", { force: true });\nawait fs.rm("scripts/cold-user-http-guidance-bootstrap-v4.mjs", { force: true });\nawait fs.rm(".github/workflows/cold-user-http-guidance-bootstrap.yml", { force: true });`;

const cleanupIndex = source.indexOf(cleanupNeedle);
if (cleanupIndex < 0 || source.indexOf(cleanupNeedle, cleanupIndex + cleanupNeedle.length) !== -1) {
  throw new Error("Expected exactly one bootstrap cleanup block");
}
source = source.slice(0, cleanupIndex) + cleanupReplacement + source.slice(cleanupIndex + cleanupNeedle.length);

delete process.env.GITHUB_REF_NAME;
const tempPath = "/tmp/cold-user-http-guidance-bootstrap-v4-run.mjs";
await fs.writeFile(tempPath, source, "utf8");
await import(pathToFileURL(tempPath).href + `?run=${Date.now()}`);

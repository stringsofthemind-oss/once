import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

const sourcePath = "scripts/cold-user-http-guidance-bootstrap-v2.mjs";
let source = await fs.readFile(sourcePath, "utf8");

const guidanceNeedle = String.raw`    lines.push(\`\`);\n    return lines.join("\\n");`;
const guidanceReplacement = String.raw`    if (provider) {\n      lines.push(\n        \`Configured provider: \${provider}\`,\n        \`Provider binding retained: provider: "\${provider}"\`,\n        \`\`\n      );\n    }\n\n    lines.push(\n      \`Do not replace the original call until Once reports a supported protected path.\`,\n      \`\`\n    );\n    return lines.join("\\n");`;

const guidanceIndex = source.indexOf(guidanceNeedle);
if (guidanceIndex < 0 || source.indexOf(guidanceNeedle, guidanceIndex + guidanceNeedle.length) !== -1) {
  throw new Error("Expected exactly one provider-mapping snippet return");
}
source = source.slice(0, guidanceIndex) + guidanceReplacement + source.slice(guidanceIndex + guidanceNeedle.length);

const cleanupAnchor = `await fs.rm(".github/workflows/cold-user-http-guidance-bootstrap.yml", { force: true });`;
const cleanupReplacement = [
  `await fs.rm("scripts/cold-user-http-guidance-bootstrap-v3.mjs", { force: true });`,
  `await fs.rm("scripts/cold-user-http-guidance-bootstrap-v4.mjs", { force: true });`,
  `await fs.rm("scripts/cold-user-http-guidance-bootstrap-v5.mjs", { force: true });`,
  `await fs.rm("scripts/cold-user-http-guidance-bootstrap-v6.mjs", { force: true });`,
  cleanupAnchor
].join("\n");

const cleanupIndex = source.indexOf(cleanupAnchor);
if (cleanupIndex < 0 || source.indexOf(cleanupAnchor, cleanupIndex + cleanupAnchor.length) !== -1) {
  throw new Error("Expected exactly one workflow cleanup anchor");
}
source = source.slice(0, cleanupIndex) + cleanupReplacement + source.slice(cleanupIndex + cleanupAnchor.length);

delete process.env.GITHUB_REF_NAME;
const tempPath = "/tmp/cold-user-http-guidance-bootstrap-v6-run.mjs";
await fs.writeFile(tempPath, source, "utf8");
await import(pathToFileURL(tempPath).href + `?run=${Date.now()}`);

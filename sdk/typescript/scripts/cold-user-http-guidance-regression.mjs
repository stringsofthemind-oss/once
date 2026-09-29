import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "dist", "cli.js");
const temp = path.join(root, ".cold-user-http-guidance-regression-temp");

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function runProtect() {
  const result = spawnSync(process.execPath, [cli, "protect", temp, "--all", "--write-plan", "--snippets"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error("Cold-user HTTP guidance regression failed");
  }
  return result.stdout;
}

await rm(temp, { recursive: true, force: true });
await mkdir(path.join(temp, "src"), { recursive: true });

const supportedPath = path.join(temp, "src", "supported.ts");
const unsupportedPath = path.join(temp, "src", "unsupported.ts");

const supportedSource = [
  "export async function createOrder(",
  "  operationId: string,",
  "  payload: unknown",
  ") {",
  "  await fetch(",
  "    \"https://api.example.invalid/orders\",",
  "    {",
  "      method: \"POST\",",
  "      body: JSON.stringify(payload)",
  "    }",
  "  );",
  "}",
  ""
].join("\n");

const unsupportedSource = [
  "export async function createIssue(",
  "  operationId: string,",
  "  payload: unknown,",
  "  repo: string",
  ") {",
  "  const url = \"https://api.github.com/repos/\" + repo + \"/issues\";",
  "  const response = await fetch(",
  "    url,",
  "    {",
  "      method: \"POST\",",
  "      headers: {",
  "        \"Content-Type\": \"application/json\",",
  "        Authorization: \"Bearer test-token\"",
  "      },",
  "      body: JSON.stringify(payload)",
  "    }",
  "  );",
  "  return await response.json();",
  "}",
  ""
].join("\n");

await writeFile(supportedPath, supportedSource, "utf8");
await writeFile(unsupportedPath, unsupportedSource, "utf8");
const beforeSupported = hash(await readFile(supportedPath));
const beforeUnsupported = hash(await readFile(unsupportedPath));

console.log("\nCOLD-USER HTTP GUIDANCE REGRESSION");
console.log("=================================");

const output = runProtect();
const plan = JSON.parse(await readFile(path.join(temp, ".once", "protect-plan.json"), "utf8"));
if (plan.provider !== null) throw new Error("Regression unexpectedly configured a provider");

const byFile = suffix => plan.candidates.find(candidate => candidate.file.replaceAll("\\", "/").endsWith(suffix));
const supported = byFile("src/supported.ts");
const unsupported = byFile("src/unsupported.ts");
if (!supported || !unsupported) throw new Error("Expected supported and unsupported candidates; got " + plan.candidates.length);

if (supported.automation_status !== "PROVIDER_MAPPING_REQUIRED") throw new Error("Supported no-provider candidate changed status: " + supported.automation_status);
if (supported.source_shape !== "SUPPORTED") throw new Error("Expected SUPPORTED source preflight; got " + supported.source_shape);
if (supported.target_url !== "https://api.example.invalid/orders") throw new Error("Expected exact target URL; got " + supported.target_url);
if (supported.auto_apply_eligible !== false) throw new Error("Source preflight incorrectly enabled auto-apply");

if (unsupported.automation_status !== "PROVIDER_MAPPING_REQUIRED") throw new Error("Unsupported no-provider candidate changed status: " + unsupported.automation_status);
if (unsupported.source_shape !== "UNSUPPORTED") throw new Error("Expected UNSUPPORTED source preflight; got " + unsupported.source_shape);
if (unsupported.auto_apply_eligible !== false) throw new Error("Unsupported source preflight incorrectly enabled auto-apply");
if (!String(unsupported.automation_reason).includes("Provider setup alone will not make this callsite auto-apply eligible")) throw new Error("Unsupported candidate does not explain that provider setup alone is insufficient");

const exactSetup = 'npx --yes --package=@once-agent/sdk once setup . --runtime-http="https://api.example.invalid/orders"';
if (!output.includes(exactSetup)) throw new Error("Supported source did not receive exact runtime-http setup guidance");
if (!output.includes("Provider setup alone will not make this callsite auto-apply eligible.")) throw new Error("Unsupported source did not receive bounded fail-closed guidance");

const snippetDir = path.join(temp, ".once", "protect-snippets");
const snippets = [];
for (const entry of await readdir(snippetDir, { withFileTypes: true })) {
  if (entry.isFile()) snippets.push(await readFile(path.join(snippetDir, entry.name), "utf8"));
}
const supportedSnippet = snippets.find(value => value.includes("src/supported.ts"));
const unsupportedSnippet = snippets.find(value => value.includes("src/unsupported.ts"));
if (!supportedSnippet || !unsupportedSnippet) throw new Error("Expected both guidance snippets");
if (!supportedSnippet.includes(exactSetup)) throw new Error("Supported snippet is missing exact setup path");
if (!unsupportedSnippet.includes("Provider setup alone will not make this callsite auto-apply eligible.")) throw new Error("Unsupported snippet is missing fail-closed explanation");
for (const snippet of [supportedSnippet, unsupportedSnippet]) {
  if (snippet.includes("YOUR_PROVIDER") || snippet.includes("DEFINE_PROVIDER_ACTION")) throw new Error("Provider-mapping snippet still contains placeholder dead-end guidance");
}

if (beforeSupported !== hash(await readFile(supportedPath)) || beforeUnsupported !== hash(await readFile(unsupportedPath))) throw new Error("Read-only source preflight modified application source");

console.log("PASS - supported source gets exact runtime-http next step");
console.log("PASS - unsupported source explains provider setup is insufficient");
console.log("PASS - both remain PROVIDER_MAPPING_REQUIRED and auto-apply false");
console.log("PASS - placeholder provider dead end removed from mapping snippets");
console.log("PASS - application source unchanged");
await rm(temp, { recursive: true, force: true });
console.log("\nCOLD-USER HTTP GUIDANCE REGRESSION PASSED");

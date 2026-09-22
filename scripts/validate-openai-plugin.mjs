import { readFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const pluginRoot = path.join(root, "plugins", "openai", "once");
const paths = {
  manifest: path.join(pluginRoot, ".codex-plugin", "plugin.json"),
  marketplace: path.join(root, ".agents", "plugins", "marketplace.json"),
  mcp: path.join(pluginRoot, ".mcp.json"),
  launcher: path.join(pluginRoot, "scripts", "once-mcp.cjs"),
  skill: path.join(pluginRoot, "skills", "protect-consequential-writes", "SKILL.md"),
  reference: path.join(pluginRoot, "skills", "protect-consequential-writes", "references", "routing-cases.md"),
  evals: path.join(pluginRoot, "evals", "routing-cases.json"),
  readme: path.join(pluginRoot, "README.md"),
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

for (const [name, file] of Object.entries(paths)) {
  await access(file).catch(() => {
    throw new Error(`Missing ${name}: ${path.relative(root, file)}`);
  });
}

const [manifest, marketplace, mcp, evals, skill, launcher, readme] = await Promise.all([
  readJson(paths.manifest),
  readJson(paths.marketplace),
  readJson(paths.mcp),
  readJson(paths.evals),
  readFile(paths.skill, "utf8"),
  readFile(paths.launcher, "utf8"),
  readFile(paths.readme, "utf8"),
]);

assert(manifest.name === "once", "Manifest name must be once");
assert(/^\d+\.\d+\.\d+$/.test(manifest.version), "Manifest version must be strict semver");
assert(typeof manifest.description === "string" && manifest.description.length > 20, "Manifest description is required");
assert(manifest.author?.name === "Once", "Manifest author.name must be Once");
assert(manifest.skills === "./skills/", "Manifest skills path must be ./skills/");
assert(manifest.mcpServers === "./.mcp.json", "Manifest MCP path must be ./.mcp.json");

const ui = manifest.interface;
assert(ui && typeof ui === "object", "Manifest interface block is required");
for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
  assert(typeof ui[field] === "string" && ui[field].trim(), `Manifest interface.${field} is required`);
}
assert(Array.isArray(ui.capabilities) && ui.capabilities.includes("Read") && ui.capabilities.includes("Write"), "Manifest capabilities must declare Read and Write");
assert(Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length >= 1 && ui.defaultPrompt.length <= 3, "defaultPrompt must contain 1-3 prompts");
for (const prompt of ui.defaultPrompt) {
  assert(typeof prompt === "string" && prompt.length <= 128, `defaultPrompt entry exceeds 128 characters: ${prompt}`);
}
if (ui.websiteURL) {
  assert(/^https:\/\//.test(ui.websiteURL), "websiteURL must use https");
}

assert(marketplace.name === "once-agent", "Marketplace name must be once-agent");
const marketEntry = marketplace.plugins?.find((entry) => entry.name === "once");
assert(marketEntry, "Marketplace must contain the once plugin");
assert(marketEntry.source?.source === "local", "Marketplace Once source must be local");
assert(marketEntry.source?.path === "./plugins/openai/once", "Marketplace Once path is incorrect");
assert(marketEntry.policy?.installation === "AVAILABLE", "Marketplace installation policy must be AVAILABLE");
assert(["ON_INSTALL", "ON_USE"].includes(marketEntry.policy?.authentication), "Marketplace authentication policy is invalid");
assert(marketEntry.category === "Security", "Marketplace category must be Security");

const onceServer = mcp.mcpServers?.once;
assert(onceServer, "MCP config must define mcpServers.once");
assert(onceServer.command === "node", "Once MCP launcher must use node");
assert(Array.isArray(onceServer.args) && onceServer.args[0] === "./scripts/once-mcp.cjs", "Once MCP launcher path is incorrect");
assert(launcher.includes("@once-agent/mcp@0.1.3"), "MCP package must be pinned to @once-agent/mcp@0.1.3");

assert(skill.startsWith("---\n"), "Skill must start with YAML frontmatter");
assert(/\nname:\s*protect-consequential-writes\n/.test(skill), "Skill frontmatter name is incorrect");
assert(/\ndescription:\s*/.test(skill), "Skill frontmatter description is required");
for (const phrase of [
  "change external state",
  "logical operation may be retried",
  "first attempt can become ambiguous",
  "Blind duplicate execution",
  "cross-agent",
  "UNKNOWN",
]) {
  assert(skill.includes(phrase), `Skill is missing routing/safety phrase: ${phrase}`);
}
assert(skill.includes("@once-agent/sdk@0.1.5"), "Skill CLI fallback must pin @once-agent/sdk@0.1.5");

assert(evals.schema_version === "once-openai-routing-v1", "Routing eval schema version is incorrect");
assert(Array.isArray(evals.positive) && evals.positive.length >= 5, "Routing suite needs at least five positive cases");
assert(Array.isArray(evals.negative) && evals.negative.length >= 3, "Routing suite needs at least three negative cases");
for (const testCase of [...evals.positive, ...evals.negative]) {
  assert(testCase.id && testCase.prompt && testCase.expected && testCase.reason, `Incomplete routing case: ${JSON.stringify(testCase)}`);
}
assert(evals.positive.every((testCase) => testCase.expected === "evaluate_once"), "All positive cases must expect evaluate_once");
assert(evals.negative.every((testCase) => testCase.expected === "bypass_once"), "All negative cases must expect bypass_once");

const combined = [JSON.stringify(manifest), JSON.stringify(marketplace), JSON.stringify(mcp), JSON.stringify(evals), skill, launcher, readme].join("\n");
assert(!combined.includes("[TODO:"), "Plugin package contains unresolved TODO placeholders");

console.log("OPENAI CODEX PLUGIN: PASS");
console.log(`Plugin: ${manifest.interface.displayName} v${manifest.version}`);
console.log(`Routing evals: ${evals.positive.length} positive / ${evals.negative.length} negative`);
console.log(`MCP: @once-agent/mcp@0.1.3`);
console.log(`SDK fallback: @once-agent/sdk@0.1.5`);

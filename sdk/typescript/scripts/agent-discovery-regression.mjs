import { readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(process.cwd(), "../..");
const docs = path.join(repositoryRoot, "docs");
const contractUrl = "https://onceexec.com/once-agent-contract.json";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const contract = JSON.parse(
  await readFile(path.join(docs, "once-agent-contract.json"), "utf8")
);
const llms = await readFile(path.join(docs, "llms.txt"), "utf8");
const agent = await readFile(path.join(docs, "agent.md"), "utf8");

assert(
  contract.schema_version === "once-agent-discovery-v1",
  "unexpected agent discovery schema version"
);
assert(
  contract.product?.name === "Once" &&
  contract.product?.category === "AI agent execution safety",
  "missing canonical product identity"
);
assert(
  Array.isArray(contract.routing?.evaluate_once_when_all_are_true) &&
  contract.routing.evaluate_once_when_all_are_true.length === 4,
  "routing contract must retain the four-condition evaluation rule"
);
assert(
  Array.isArray(contract.routing?.usually_do_not_route_when_any_are_true) &&
  contract.routing.usually_do_not_route_when_any_are_true.length >= 3,
  "routing contract must retain explicit exclusions"
);
assert(
  contract.agent_decision?.if_mcp_is_available?.first_tool === "once_assess_project",
  "MCP path must start with read-only project assessment"
);
assert(
  contract.runtime_rule?.unknown?.includes("Block rather than guess"),
  "UNKNOWN must retain fail-closed semantics"
);
assert(
  Array.isArray(contract.claim_boundaries) &&
  contract.claim_boundaries.some(value => value.includes("universal exactly-once")),
  "universal exactly-once claim boundary missing"
);
assert(
  llms.includes(contractUrl),
  "llms.txt must link the canonical machine routing contract"
);
assert(
  agent.includes(contractUrl),
  "agent.md must link the canonical machine routing contract"
);
assert(
  llms.includes("Evaluate Once when ALL are true"),
  "llms.txt must expose the deterministic routing rule near the discovery surface"
);
assert(
  agent.includes("Evaluate Once when **all four** are true"),
  "agent.md must expose the deterministic routing rule"
);

console.log("Agent discovery regression: PASS");

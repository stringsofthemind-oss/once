import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";

const EXPECTED_BASE = "e6fb1238e4d1ebd5f50139c460b7c232eff7696b";
const EXPECTED_BRANCH = "adoption/cold-user-http-guidance-v1";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    ...options
  });
}

function requireText(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`Missing expected ${label}`);
  }
}

function replaceOnce(source, needle, replacement, label) {
  requireText(source, needle, label);
  const first = source.indexOf(needle);
  if (source.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`Expected exactly one ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function replaceSection(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing ${label} start marker`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing ${label} end marker`);
  return source.slice(0, start) + replacement + source.slice(end);
}

const branch = process.env.GITHUB_REF_NAME || run("git", ["branch", "--show-current"], { capture: true }).trim();
if (branch !== EXPECTED_BRANCH) {
  throw new Error(`Wrong branch: ${branch}`);
}
run("git", ["merge-base", "--is-ancestor", EXPECTED_BASE, "HEAD"]);
if (run("git", ["status", "--short"], { capture: true }).trim()) {
  throw new Error("Worktree is not clean before bootstrap");
}

const protectPath = "sdk/typescript/src/protect.ts";
let protect = await fs.readFile(protectPath, "utf8");

protect = replaceOnce(
  protect,
  `  transformer_id?: string;\n  transformer_reason?: string;\n  binding_required?: boolean;`,
  `  transformer_id?: string;\n  transformer_reason?: string;\n  source_shape?: "SUPPORTED" | "UNSUPPORTED";\n  source_shape_reason?: string;\n  binding_required?: boolean;`,
  "ProtectionCandidate source-shape fields"
);

const newSnippetFunction = `function buildIntegrationSnippet(\n  candidate: ProtectionCandidate,\n  provider: string | null\n): string {\n\n  const lines = [\n    \`Once protection candidate\`,\n    \`=========================\`,\n    \`\`,\n    \`Callsite: \${candidate.file}:\${candidate.line}\`,\n    \`Reference: \${candidate.callsite_ref}\`,\n    \`Confidence: \${candidate.confidence}\`,\n    \`Category: \${candidate.category}\`,\n    \`Automation: \${candidate.automation_status}\`,\n    \`Auto-apply eligible: \${\n      candidate.auto_apply_eligible\n        ? "yes"\n        : "no"\n    }\`,\n    \`Automation reason: \${candidate.automation_reason}\`,\n    ...(candidate.source_shape\n      ? [\n          \`Source-shape preflight: \${candidate.source_shape}\`,\n          \`Source-shape reason: \${candidate.source_shape_reason ?? "not available"}\`\n        ]\n      : []),\n    \`\`,\n    \`IMPORTANT\`,\n    \`---------\`,\n    \`This is integration guidance, not an automatic source rewrite.\`,\n    \`Preserve the original operation semantics.\`,\n    \`Use one stable operationId for each real-world action.\`,\n    \`Retries of that same action must reuse the same operationId.\`\n  ];\n\n  if (\n    candidate.automation_status ===\n      "PROVIDER_MAPPING_REQUIRED"\n  ) {\n    lines.push(\n      \`\`,\n      \`NEXT STEP FOR PROVIDER_MAPPING_REQUIRED\`,\n      \`---------------------------------------\`\n    );\n\n    if (\n      candidate.source_shape === "SUPPORTED" &&\n      candidate.target_url\n    ) {\n      lines.push(\n        \`The current source shape is inside the proven HTTP transformer boundary.\`,\n        \`Provider mapping is still required before any rewrite can become eligible.\`,\n        \`Configure the exact literal target with:\`,\n        \`npx --yes --package=@once-agent/sdk once setup . --runtime-http=\${JSON.stringify(candidate.target_url)}\`,\n        \`Then rerun:\`,\n        \`npx --yes --package=@once-agent/sdk once doctor . --protect\`,\n        \`Only use --apply if the fresh result is PATCHABLE.\`\n      );\n    }\n    else if (\n      candidate.source_shape ===\n        "UNSUPPORTED"\n    ) {\n      lines.push(\n        \`The current source shape is outside the proven automatic HTTP transformer boundary.\`,\n        \`Reason: \${candidate.source_shape_reason ?? "unsupported source shape"}\`,\n        \`Provider setup alone will not make this callsite auto-apply eligible.\`,\n        \`Keep the original call unchanged until a supported integration preserves its exact effect and recovery semantics.\`\n      );\n    }\n    else {\n      lines.push(\n        \`Once cannot yet prove an automatic HTTP rewrite for this callsite.\`,\n        \`Provider setup alone is not permission to rewrite or execute it.\`\n      );\n    }\n\n    lines.push(\`\`);\n    return lines.join("\\n");\n  }\n\n  if (\n    candidate.automation_status ===\n      "ADAPTER_REQUIRED"\n  ) {\n    lines.push(\n      \`\`,\n      \`NEXT STEPS FOR ADAPTER_REQUIRED\`,\n      \`-------------------------------\`,\n      \`No automatic source rewrite is available for this callsite.\`,\n      \`For a controlled first proof with a fake effect on one machine, see:\`,\n      \`https://github.com/stringsofthemind-oss/once/tree/main/examples/local-function\`,\n      \`That Node 24.15+ proof needs no API key; it is not a production\`,\n      \`integration and does not coordinate separate hosts.\`,\n      \`For the real operation, first establish a supported provider adapter\`,\n      \`or capability that preserves the exact effect and recovery semantics.\`,\n      \`Do not replace the original call merely because it was detected.\`\n    );\n  }\n\n  const providerName =\n    provider ??\n    "YOUR_PROVIDER";\n\n  lines.push(\n    \`\`,\n    \`Configured provider: \${providerName}\`,\n    \`\`,\n    \`TypeScript shape\`,\n    \`----------------\`,\n    \`\`,\n    \`const result = await once.execute({\`,\n    \`  operationId,\`,\n    \`  provider: "\${providerName}",\`,\n    \`  action: {\`,\n    \`    type: "DEFINE_PROVIDER_ACTION",\`,\n    \`    // Include only the fields your provider requires.\`,\n    \`  }\`,\n    \`});\`,\n    \`\`,\n    \`Do not replace the original call until the configured\`,\n    \`provider is capable of performing this exact side effect.\`,\n    \`\`\n  );\n\n  return lines.join("\\n");\n}\n\n`;

protect = replaceSection(
  protect,
  "function buildIntegrationSnippet(",
  "function buildPatchPreview(",
  newSnippetFunction,
  "buildIntegrationSnippet"
);

const newClassificationFunction = `async function applyTransformerClassification(\n  root: string,\n  finding: Finding,\n  candidate: ProtectionCandidate,\n  provider: string | null,\n  manifest: CapabilityManifest | null\n): Promise<void> {\n\n  if (\n    finding.category !==\n      "HTTP_WRITE"\n  ) {\n    return;\n  }\n\n  const markUnsupported =\n    (reason: string): void => {\n      candidate.source_shape =\n        "UNSUPPORTED";\n      candidate.source_shape_reason =\n        reason;\n      candidate.transformer_reason =\n        reason;\n\n      if (\n        candidate.automation_status ===\n          "PROVIDER_MAPPING_REQUIRED"\n      ) {\n        candidate.automation_reason =\n          \`Provider mapping is not the only blocker. The current proven HTTP transformer rejects this source shape: \${reason} Provider setup alone will not make this callsite auto-apply eligible.\`;\n      }\n    };\n\n  if (\n    !/\\.(?:ts|tsx|mts|cts)$/i.test(\n      finding.file\n    )\n  ) {\n    markUnsupported(\n      "The proven HTTP transformer currently supports TypeScript source only."\n    );\n    return;\n  }\n\n  const sourcePath =\n    path.resolve(\n      root,\n      finding.file\n    );\n\n  const relative =\n    path.relative(\n      root,\n      sourcePath\n    );\n\n  if (\n    relative.startsWith(\n      ".."\n    ) ||\n    path.isAbsolute(\n      relative\n    )\n  ) {\n    markUnsupported(\n      "Source path escaped the project root."\n    );\n    return;\n  }\n\n  let source:\n    string;\n\n  try {\n    source =\n      await fs.readFile(\n        sourcePath,\n        "utf8"\n      );\n  }\n  catch {\n    markUnsupported(\n      "Source file could not be read."\n    );\n    return;\n  }\n\n  const extracted =\n    extractAwaitFetchStatement(\n      source,\n      finding.line\n    );\n\n  if (!extracted) {\n    markUnsupported(\n      "No exact supported await fetch statement could be extracted."\n    );\n    return;\n  }\n\n  if (\n    !finding.functionName\n  ) {\n    markUnsupported(\n      "The supported transformer requires a named function containing the operation."\n    );\n    return;\n  }\n\n  const functionSource =\n    extractFunctionDeclarationSource(\n      source,\n      finding.functionName,\n      extracted.startOffset\n    );\n\n  if (!functionSource) {\n    markUnsupported(\n      "The surrounding supported function declaration could not be identified."\n    );\n    return;\n  }\n\n  const result =\n    transformHttpWriteV1({\n      statement:\n        extracted.statement,\n      functionSource,\n      provider:\n        provider ??\n        "__once_source_preflight__"\n    });\n\n  if (!result.eligible) {\n    markUnsupported(\n      result.reason\n    );\n    return;\n  }\n\n  candidate.source_shape =\n    "SUPPORTED";\n  candidate.source_shape_reason =\n    "The exact source shape matches the current proven HTTP transformer contract.";\n  candidate.target_url =\n    result.url;\n\n  if (!provider) {\n    candidate.automation_reason =\n      \`Source shape matches the proven HTTP transformer, but provider mapping is still required before any rewrite can become eligible. Exact target: \${result.url}.\`;\n    return;\n  }\n\n  if (\n    candidate.automation_status !==\n      "PROVIDER_CAPABILITY_DECLARED"\n  ) {\n    candidate.automation_reason =\n      "Source shape matches the proven HTTP transformer, but the configured provider does not yet declare the required http_write_v1 capability for this callsite.";\n    return;\n  }\n\n  const capability =\n    manifest?.capabilities.find(\n      item =>\n        item.category ===\n          "HTTP_WRITE" &&\n        item.action_type ===\n          "http_write_v1"\n    );\n\n  if (!capability) {\n    return;\n  }\n\n  const allowedUrls =\n    capability.allowed_urls;\n\n  if (\n    !Array.isArray(\n      allowedUrls\n    ) ||\n    !allowedUrls.includes(\n      result.url\n    )\n  ) {\n    candidate.transformer_reason =\n      \`Capability does not explicitly allow target URL \${result.url}.\`;\n    return;\n  }\n\n  candidate.automation_status =\n    "TRANSFORMER_MATCHED";\n\n  candidate.automation_reason =\n    "The exact source pattern was accepted by the proven ts_fetch_post_void_v1 transformer. Full source-patch planning is now being validated.";\n\n  candidate.transformer_id =\n    result.transformer;\n\n  candidate.transformer_reason =\n    "Exact transformer contract matched.";\n\n  candidate.binding_required =\n    result.requiresOnceBinding;\n\n  const patchPlan =\n    buildHttpWritePatchV1({\n      source,\n      statement:\n        extracted.statement,\n      functionSource,\n      provider\n    });\n\n  if (\n    !patchPlan.eligible\n  ) {\n    candidate.transformer_reason =\n      \`Transformer matched, but complete patch planning failed closed: \${patchPlan.reason}\`;\n    return;\n  }\n\n  candidate.automation_status =\n    "PATCHABLE";\n\n  candidate.automation_reason =\n    "Scanner match, provider capability, transformer contract, call-site Once binding and deterministic full-source patch planning all succeeded.";\n\n  candidate.auto_apply_eligible =\n    true;\n\n  candidate.binding_required =\n    false;\n\n  candidate.binding_strategy =\n    patchPlan.bindingStrategy;\n\n  candidate.patch_plan_id =\n    patchPlan.patchPlan;\n\n  candidate.source_sha256 =\n    patchPlan.sourceSha256;\n\n  candidate.proposed_source_sha256 =\n    patchPlan.proposedSourceSha256;\n\n  candidate.transformer_reason =\n    "Complete deterministic source patch successfully planned in memory.";\n}\n\n`;

protect = replaceSection(
  protect,
  "async function applyTransformerClassification(",
  "export async function runProtect(",
  newClassificationFunction,
  "applyTransformerClassification"
);

const transformerPrintMarker = `    if (\n      candidate.transformer_id\n    ) {`;
const guidancePrint = `    console.log(\n      \`  \${candidate.automation_reason}\`\n    );\n\n    if (\n      candidate.source_shape\n    ) {\n      console.log(\n        \`  Source-shape preflight: \${candidate.source_shape}\`\n      );\n\n      console.log(\n        \`  Source-shape reason: \${candidate.source_shape_reason ?? "not available"}\`\n      );\n    }\n\n    if (\n      candidate.automation_status ===\n        "PROVIDER_MAPPING_REQUIRED" &&\n      candidate.source_shape ===\n        "SUPPORTED" &&\n      candidate.target_url\n    ) {\n      console.log(\n        \`  Next setup: npx --yes --package=@once-agent/sdk once setup . --runtime-http=\${JSON.stringify(candidate.target_url)}\`\n      );\n      console.log(\n        "  Then rerun doctor --protect; use --apply only if the fresh result is PATCHABLE."\n      );\n    }\n    else if (\n      candidate.automation_status ===\n        "PROVIDER_MAPPING_REQUIRED" &&\n      candidate.source_shape ===\n        "UNSUPPORTED"\n    ) {\n      console.log(\n        "  Provider setup alone will not make this callsite auto-apply eligible."\n      );\n    }\n\n`;
protect = replaceOnce(
  protect,
  transformerPrintMarker,
  guidancePrint + transformerPrintMarker,
  "candidate guidance output insertion"
);

await fs.writeFile(protectPath, protect, "utf8");

const regressionPath = "sdk/typescript/scripts/cold-user-http-guidance-regression.mjs";
const regression = `import {\n  mkdir,\n  readFile,\n  readdir,\n  rm,\n  writeFile\n} from "node:fs/promises";\nimport { createHash } from "node:crypto";\nimport { spawnSync } from "node:child_process";\nimport path from "node:path";\n\nconst root = process.cwd();\nconst cli = path.join(root, "dist", "cli.js");\nconst temp = path.join(root, ".cold-user-http-guidance-regression-temp");\n\nfunction hash(value) {\n  return createHash("sha256").update(value).digest("hex");\n}\n\nfunction runProtect() {\n  const result = spawnSync(\n    process.execPath,\n    [cli, "protect", temp, "--all", "--write-plan", "--snippets"],\n    { cwd: root, encoding: "utf8" }\n  );\n  if (result.status !== 0) {\n    console.error(result.stdout);\n    console.error(result.stderr);\n    throw new Error("Cold-user HTTP guidance regression failed");\n  }\n  return result.stdout;\n}\n\nawait rm(temp, { recursive: true, force: true });\nawait mkdir(path.join(temp, "src"), { recursive: true });\n\nconst supportedPath = path.join(temp, "src", "supported.ts");\nconst unsupportedPath = path.join(temp, "src", "unsupported.ts");\n\nconst supportedSource = \`\nexport async function createOrder(\n  operationId: string,\n  payload: unknown\n) {\n  await fetch(\n    "https://api.example.invalid/orders",\n    {\n      method: "POST",\n      body: JSON.stringify(payload)\n    }\n  );\n}\n\`.trimStart();\n\nconst unsupportedSource = \`\nexport async function createIssue(\n  operationId: string,\n  payload: unknown,\n  repo: string,\n  token: string\n) {\n  const response = await fetch(\n    \\\`https://api.github.com/repos/\${repo}/issues\\\`,\n    {\n      method: "POST",\n      headers: {\n        "Content-Type": "application/json",\n        Authorization: \\\`Bearer \${token}\\\`\n      },\n      body: JSON.stringify(payload)\n    }\n  );\n  return await response.json();\n}\n\`.trimStart();\n\nawait writeFile(supportedPath, supportedSource, "utf8");\nawait writeFile(unsupportedPath, unsupportedSource, "utf8");\n\nconst beforeSupported = hash(await readFile(supportedPath));\nconst beforeUnsupported = hash(await readFile(unsupportedPath));\n\nconsole.log("\\nCOLD-USER HTTP GUIDANCE REGRESSION");\nconsole.log("=================================");\n\nconst output = runProtect();\nconst plan = JSON.parse(await readFile(path.join(temp, ".once", "protect-plan.json"), "utf8"));\n\nif (plan.provider !== null) {\n  throw new Error("Regression unexpectedly configured a provider");\n}\n\nconst byFile = suffix => plan.candidates.find(candidate =>\n  candidate.file.replaceAll("\\\\", "/").endsWith(suffix)\n);\nconst supported = byFile("src/supported.ts");\nconst unsupported = byFile("src/unsupported.ts");\n\nif (!supported || !unsupported) {\n  throw new Error(`Expected supported and unsupported candidates; got \${plan.candidates.length}`);\n}\n\nif (supported.automation_status !== "PROVIDER_MAPPING_REQUIRED") {\n  throw new Error(`Supported no-provider candidate changed status: \${supported.automation_status}`);\n}\nif (supported.source_shape !== "SUPPORTED") {\n  throw new Error(`Expected SUPPORTED source preflight; got \${supported.source_shape}`);\n}\nif (supported.target_url !== "https://api.example.invalid/orders") {\n  throw new Error(`Expected exact target URL; got \${supported.target_url}`);\n}\nif (supported.auto_apply_eligible !== false) {\n  throw new Error("Source preflight incorrectly enabled auto-apply");\n}\n\nif (unsupported.automation_status !== "PROVIDER_MAPPING_REQUIRED") {\n  throw new Error(`Unsupported no-provider candidate changed status: \${unsupported.automation_status}`);\n}\nif (unsupported.source_shape !== "UNSUPPORTED") {\n  throw new Error(`Expected UNSUPPORTED source preflight; got \${unsupported.source_shape}`);\n}\nif (unsupported.auto_apply_eligible !== false) {\n  throw new Error("Unsupported source preflight incorrectly enabled auto-apply");\n}\nif (!String(unsupported.automation_reason).includes("Provider setup alone will not make this callsite auto-apply eligible")) {\n  throw new Error("Unsupported candidate does not explain that provider setup alone is insufficient");\n}\n\nconst exactSetup = 'npx --yes --package=@once-agent/sdk once setup . --runtime-http="https://api.example.invalid/orders"';\nif (!output.includes(exactSetup)) {\n  throw new Error("Supported source did not receive exact runtime-http setup guidance");\n}\nif (!output.includes("Provider setup alone will not make this callsite auto-apply eligible.")) {\n  throw new Error("Unsupported source did not receive bounded fail-closed guidance");\n}\n\nconst snippetDir = path.join(temp, ".once", "protect-snippets");\nconst snippets = [];\nfor (const entry of await readdir(snippetDir, { withFileTypes: true })) {\n  if (entry.isFile()) snippets.push(await readFile(path.join(snippetDir, entry.name), "utf8"));\n}\nconst supportedSnippet = snippets.find(value => value.includes("src/supported.ts"));\nconst unsupportedSnippet = snippets.find(value => value.includes("src/unsupported.ts"));\nif (!supportedSnippet || !unsupportedSnippet) {\n  throw new Error("Expected both guidance snippets");\n}\nif (!supportedSnippet.includes(exactSetup)) {\n  throw new Error("Supported snippet is missing exact setup path");\n}\nif (!unsupportedSnippet.includes("Provider setup alone will not make this callsite auto-apply eligible.")) {\n  throw new Error("Unsupported snippet is missing fail-closed explanation");\n}\nfor (const snippet of [supportedSnippet, unsupportedSnippet]) {\n  if (snippet.includes("YOUR_PROVIDER") || snippet.includes("DEFINE_PROVIDER_ACTION")) {\n    throw new Error("Provider-mapping snippet still contains placeholder dead-end guidance");\n  }\n}\n\nif (beforeSupported !== hash(await readFile(supportedPath)) ||\n    beforeUnsupported !== hash(await readFile(unsupportedPath))) {\n  throw new Error("Read-only source preflight modified application source");\n}\n\nconsole.log("PASS - supported source gets exact runtime-http next step");\nconsole.log("PASS - unsupported source explains provider setup is insufficient");\nconsole.log("PASS - both remain PROVIDER_MAPPING_REQUIRED and auto-apply false");\nconsole.log("PASS - placeholder provider dead end removed from mapping snippets");\nconsole.log("PASS - application source unchanged");\n\nawait rm(temp, { recursive: true, force: true });\nconsole.log("\\nCOLD-USER HTTP GUIDANCE REGRESSION PASSED");\n`;
await fs.writeFile(regressionPath, regression, "utf8");

const packagePath = "sdk/typescript/package.json";
const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
const oldTransformerProtect = "npm run build && node ./scripts/transformer-protect-regression.mjs";
if (pkg.scripts["test:transformer-protect"] !== oldTransformerProtect) {
  throw new Error("Unexpected test:transformer-protect script");
}
pkg.scripts["test:transformer-protect"] = oldTransformerProtect + " && node ./scripts/cold-user-http-guidance-regression.mjs";
await fs.writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

const readmePath = "README.md";
let readme = await fs.readFile(readmePath, "utf8");
readme = replaceOnce(
  readme,
  `Preview setup without making changes:\n\n\`\`\`bash\nnpx once setup . --plan\n\`\`\``,
  `Preview setup without making changes:\n\n\`\`\`bash\nnpx once setup . --plan\n\`\`\`\n\nFor a literal HTTPS fetch call that the read-only source-shape preflight reports as supported, configure the exact target through the existing Runtime HTTP path:\n\n\`\`\`bash\nnpx --yes --package=@once-agent/sdk once setup . --runtime-http=https://api.example.com/resource\n\`\`\`\n\nThis setup step does not make an unsupported callsite safe to rewrite. Rerun \`doctor . --protect\` afterward and use \`--apply\` only if the fresh result is \`PATCHABLE\`.`,
  "README runtime-http setup guidance"
);
readme = replaceOnce(
  readme,
  "- `PROVIDER_MAPPING_REQUIRED` - the call needs a provider mapping before protection can be planned",
  "- `PROVIDER_MAPPING_REQUIRED` - the call still needs provider mapping; Once also reports a read-only source-shape preflight so a user can see whether provider setup can lead to the current proven transformer or whether the source shape is already unsupported",
  "README provider mapping status"
);
await fs.writeFile(readmePath, readme, "utf8");

const connectPath = "docs/CONNECT_AUTO.md";
let connect = await fs.readFile(connectPath, "utf8");
connect = replaceOnce(
  connect,
  `> **Published status:** automatic Connect is available in\n> \`@once-agent/sdk@0.1.13\`. Its source, packed-package, ESM/CommonJS, and\n> Node.js 24.15 protected-execution release gates passed.`,
  `> **Published history:** automatic Connect was introduced in\n> \`@once-agent/sdk@0.1.13\`. That release passed its source, packed-package,\n> ESM/CommonJS, and Node.js 24.15 protected-execution gates. See the repository\n> README and published-version contract for the current SDK version.`,
  "Connect published-history wording"
);
await fs.writeFile(connectPath, connect, "utf8");

const localPath = "examples/local-function/README.md";
let local = await fs.readFile(localPath, "utf8");
local = replaceOnce(
  local,
  `\`protectLocal\` is available in the published \`@once-agent/sdk\` 0.1.7 package.\nThis guide covers its durable same-machine SQLite safety boundary.`,
  `\`protectLocal\` was introduced in the published \`@once-agent/sdk\` 0.1.7 package\nand remains part of the current SDK. This guide covers its durable same-machine\nSQLite safety boundary.`,
  "protectLocal introduced-version wording"
);
local = replaceOnce(
  local,
  `The runnable [\`verify.mjs\`](./verify.mjs) is a controlled first proof using a\nfake provider. It does not call a real payment or order API. With Node.js\n24.15+ installed, run it in a new throwaway directory:`,
  `The runnable [\`verify.mjs\`](./verify.mjs) is a controlled first proof using a\nfake provider. It does not call a real payment or order API. The reproduction\ncommands below are intentionally frozen to the historical v0.1.9 proof; that\nversion pin is reproducibility evidence, not a statement that v0.1.9 is the\ncurrent SDK. With Node.js 24.15+ installed, run it in a new throwaway directory:`,
  "local proof historical-version wording"
);
await fs.writeFile(localPath, local, "utf8");

run("npm", ["ci"], { cwd: "sdk/typescript" });
run("npm", ["run", "test:transformer-protect"], { cwd: "sdk/typescript" });
run("npm", ["run", "test:protect"], { cwd: "sdk/typescript" });
run("npm", ["run", "test:transformer"], { cwd: "sdk/typescript" });
const coverage = run("npm", ["run", "benchmark:http-autoprotection"], { cwd: "sdk/typescript", capture: true });
process.stdout.write(coverage);
if (!coverage.includes("6") || !coverage.includes("40.00%")) {
  throw new Error("HTTP autoprotection benchmark no longer reports the pinned 6/15 (40.00%) surface");
}

await fs.rm("scripts/cold-user-http-guidance-bootstrap.mjs", { force: true });
await fs.rm(".github/workflows/cold-user-http-guidance-bootstrap.yml", { force: true });

run("git", ["config", "user.name", "github-actions[bot]"]);
run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
run("git", ["add", "-A"]);
const changed = run("git", ["status", "--short"], { capture: true }).trim();
if (!changed) throw new Error("Bootstrap produced no changes");
console.log("\nFINAL DIFF FILES\n----------------");
console.log(run("git", ["diff", "--cached", "--name-only"], { capture: true }));
run("git", ["commit", "-m", "Improve cold-user HTTP protection guidance [cold-user-guidance-applied]"]);
run("git", ["push", "origin", `HEAD:${EXPECTED_BRANCH}`]);

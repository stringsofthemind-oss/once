import {
  createHash
} from "node:crypto";

import {
  promises as fs
} from "node:fs";

import path from "node:path";

import {
  collectSourceFiles,
  scanFile,
  type Finding
} from "./scan.js";

import {
  transformHttpWriteV1
} from "./transformers/http-write-v1.js";

import {
  buildHttpWritePatchV1
} from "./transformers/http-patch-plan-v1.js";

export type ProtectOptions = {
  includeAll?: boolean;
  writePlan?: boolean;
  writePatch?: boolean;
  writeSnippets?: boolean;
};

type CapabilityDeclaration = {
  category: string;
  action_type: string;
  allowed_urls?: string[];
  description?: string;
};

type CapabilityManifest = {
  schema_version: 1;
  provider: string;
  capabilities: CapabilityDeclaration[];
};

type OnceConfig = {
  provider?: {
    name?: string;
  };
};

type AutomationStatus =
  | "PROVIDER_MAPPING_REQUIRED"
  | "PROVIDER_CAPABILITY_DECLARED"
  | "TRANSFORMER_MATCHED"
  | "PATCHABLE"
  | "ADAPTER_REQUIRED"
  | "MANUAL_REVIEW";

type ProtectionCandidate = {
  callsite_ref: string;
  file: string;
  line: number;
  function_name: string | null;
  confidence: string;
  category: string;
  reason: string;
  automation_status: AutomationStatus;
  automation_reason: string;
  auto_apply_eligible: boolean;
  transformer_id?: string;
  transformer_reason?: string;
  binding_required?: boolean;
  binding_strategy?: string;
  patch_plan_id?: string;
  source_sha256?: string;
  proposed_source_sha256?: string;
  target_url?: string;
  runtime_operation_id_rule: string;
};

type ProtectPlan = {
  schema_version: 1;
  generated_at: string;
  project: string;
  provider: string | null;
  source_modified: false;
  candidates: ProtectionCandidate[];
};

async function readCapabilityManifest(
  root: string,
  provider: string | null
): Promise<CapabilityManifest | null> {

  if (!provider) {
    return null;
  }

  try {
    const raw =
      await fs.readFile(
        path.join(
          root,
          ".once",
          "provider-capabilities.json"
        ),
        "utf8"
      );

    const manifest =
      JSON.parse(
        raw.replace(
          /^\uFEFF/,
          ""
        )
      ) as CapabilityManifest;

    if (
      manifest.schema_version !== 1 ||
      manifest.provider !== provider ||
      !Array.isArray(
        manifest.capabilities
      )
    ) {
      return null;
    }

    return manifest;

  } catch {
    return null;
  }
}

async function readProvider(
  root: string
): Promise<string | null> {

  try {
    const raw =
      await fs.readFile(
        path.join(
          root,
          ".once",
          "config.json"
        ),
        "utf8"
      );

    const config =
      JSON.parse(raw) as
        OnceConfig;

    const name =
      config.provider?.name;

    if (
      typeof name === "string" &&
      name.trim()
    ) {
      return name.trim();
    }

  } catch {
    // Setup may not have been run yet.
  }

  return null;
}

function confidenceRank(
  confidence: string
): number {

  switch (confidence) {

    case "HIGH":
      return 0;

    case "MEDIUM":
      return 1;

    case "LOW":
      return 2;

    default:
      return 3;
  }
}

function callsiteRef(
  finding: Finding
): string {

  const identity = [
    finding.file,
    finding.line,
    finding.functionName ?? "",
    finding.category
  ].join(":");

  return (
    "cs_" +
    createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 16)
  );
}

function automationForCategory(
  category: string,
  manifest: CapabilityManifest | null
): {
  status: AutomationStatus;
  reason: string;
} {

  const declaredCapability =
    manifest?.capabilities.find(
      capability =>
        capability.category ===
        category
    );

  if (declaredCapability) {
    return {
      status:
        "PROVIDER_CAPABILITY_DECLARED",
      reason:
        `Provider declares capability ${declaredCapability.action_type} for ${category}, but no source transformer has yet been proven safe for automatic application.`
    };
  }

  switch (category) {

    case "HTTP_WRITE":
    case "HTTP_DELETE":
      return {
        status:
          "PROVIDER_MAPPING_REQUIRED",
        reason:
          "HTTP side effect detected, but Once must verify that the configured provider reproduces the exact original request semantics before source rewriting."
      };

    case "PAYMENT":
    case "MESSAGING":
    case "BOOKING":
    case "DATABASE":
    case "STORAGE":
    case "QUEUE":
    case "PUBLISH":
      return {
        status:
          "ADAPTER_REQUIRED",
        reason:
          "This operation requires an adapter or capability definition that preserves the original side-effect semantics."
      };

    default:
      return {
        status:
          "MANUAL_REVIEW",
        reason:
          "Once detected a consequential operation but does not currently have a safe automatic transformation model for it."
      };
  }
}

function toCandidate(
  finding: Finding,
  manifest: CapabilityManifest | null
): ProtectionCandidate {

  const automation =
    automationForCategory(
      finding.category,
      manifest
    );

  return {
    callsite_ref:
      callsiteRef(finding),

    file:
      finding.file,

    line:
      finding.line,

    function_name:
      finding.functionName ??
      null,

    confidence:
      finding.confidence,

    category:
      finding.category,

    reason:
      finding.reason,

    automation_status:
      automation.status,

    automation_reason:
      automation.reason,

    auto_apply_eligible:
      false,

    runtime_operation_id_rule:
      "Use one stable operationId per real-world action. Retries of that same action must reuse it."
  };
}

function relativeImportForFile(
  file: string
): string {

  const depth =
    file
      .replaceAll("\\", "/")
      .split("/")
      .length - 1;

  return (
    "../".repeat(
      Math.max(
        0,
        depth
      )
    ) +
    ".once/runtime.js"
  );
}

function safeFileName(
  candidate: ProtectionCandidate
): string {

  const base =
    candidate.file
      .replaceAll("\\", "/")
      .replace(
        /[^A-Za-z0-9._-]+/g,
        "_"
      );

  return (
    `${candidate.callsite_ref}-${base}-${candidate.line}.txt`
  );
}

function buildIntegrationSnippet(
  candidate: ProtectionCandidate,
  provider: string | null
): string {

  const providerName =
    provider ??
    "YOUR_PROVIDER";

  return [
    `Once protection candidate`,
    `=========================`,
    ``,
    `Callsite: ${candidate.file}:${candidate.line}`,
    `Reference: ${candidate.callsite_ref}`,
    `Confidence: ${candidate.confidence}`,
    `Category: ${candidate.category}`,
    `Automation: ${candidate.automation_status}`,
    `Auto-apply eligible: ${
      candidate.auto_apply_eligible
        ? "yes"
        : "no"
    }`,
    `Automation reason: ${candidate.automation_reason}`,
    ``,
    `IMPORTANT`,
    `---------`,
    `This is integration guidance, not an automatic source rewrite.`,
    `Preserve the original operation semantics.`,
    `Use one stable operationId for each real-world action.`,
    `Retries of that same action must reuse the same operationId.`,
    ``,
    `Configured provider: ${providerName}`,
    ``,
    `TypeScript shape`,
    `----------------`,
    ``,
    `const result = await once.execute({`,
    `  operationId,`,
    `  provider: "${providerName}",`,
    `  action: {`,
    `    type: "DEFINE_PROVIDER_ACTION",`,
    `    // Include only the fields your provider requires.`,
    `  }`,
    `});`,
    ``,
    `Do not replace the original call until the configured`,
    `provider is capable of performing this exact side effect.`,
    ``
  ].join("\n");
}

function buildPatchPreview(
  candidate: ProtectionCandidate,
  provider: string | null
): string {

  const normalized =
    candidate.file
      .replaceAll("\\", "/");

  const importPath =
    relativeImportForFile(
      normalized
    );

  const providerValue =
    provider ??
    "YOUR_PROVIDER";

  return [
    `--- a/${normalized}`,
    `+++ b/${normalized}`,
    `@@ around line ${candidate.line} @@`,
    `+ // Once protection candidate: ${candidate.callsite_ref}`,
    `+ // Provider: ${providerValue}`,
    `+ // Runtime operationId must be stable for the real-world action.`,
    `+ // Automation: ${candidate.automation_status}`,
    `+ // Auto-apply eligible: ${
      candidate.auto_apply_eligible
        ? "yes"
        : "no"
    }`,
    `+ // Suggested Once helper: ${importPath}`,
    `  [existing consequential call remains unchanged in preview]`,
    ""
  ].join("\n");
}

function escapeRegExp(
  value: string
): string {

  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function extractAwaitFetchStatement(
  source: string,
  findingLine: number
): {
  statement: string;
  startOffset: number;
} | null {

  const normalized =
    source.replace(
      /\r\n/g,
      "\n"
    );

  const lines =
    normalized.split("\n");

  const target =
    Math.max(
      0,
      Math.min(
        lines.length - 1,
        findingLine - 1
      )
    );

  /*
   * Scanner line numbers can point at the method:
   * line inside a multiline fetch call rather than
   * the `await fetch(` line itself.
   */
  let startLine =
    -1;

  for (
    let i = target;
    i >= Math.max(
      0,
      target - 12
    );
    i--
  ) {

    if (
      /\bawait\s+fetch\s*\(/.test(
        lines[i]
      )
    ) {
      startLine = i;
      break;
    }
  }

  if (
    startLine < 0
  ) {
    return null;
  }

  let lineOffset =
    0;

  for (
    let i = 0;
    i < startLine;
    i++
  ) {
    lineOffset +=
      lines[i].length + 1;
  }

  const fragment =
    normalized.slice(
      lineOffset
    );

  const awaitMatch =
    fragment.match(
      /\bawait\s+fetch\s*\(/
    );

  if (
    !awaitMatch ||
    awaitMatch.index === undefined
  ) {
    return null;
  }

  const statementStart =
    awaitMatch.index;

  const openParen =
    fragment.indexOf(
      "(",
      statementStart
    );

  if (
    openParen < 0
  ) {
    return null;
  }

  let depth =
    0;

  let quote:
    "'" | '"' | null =
      null;

  let escaped =
    false;

  let closeParen =
    -1;

  for (
    let i = openParen;
    i < fragment.length;
    i++
  ) {

    const char =
      fragment[i];

    if (quote) {

      if (escaped) {
        escaped = false;
        continue;
      }

      if (
        char === "\\"
      ) {
        escaped = true;
        continue;
      }

      if (
        char === quote
      ) {
        quote = null;
      }

      continue;
    }

    if (
      char === "`"
    ) {
      /*
       * Template literals are outside the proven
       * transformer model. Fail closed.
       */
      return null;
    }

    if (
      char === "'" ||
      char === '"'
    ) {
      quote = char;
      continue;
    }

    if (
      char === "("
    ) {
      depth++;
      continue;
    }

    if (
      char === ")"
    ) {

      depth--;

      if (
        depth === 0
      ) {
        closeParen = i;
        break;
      }
    }
  }

  if (
    closeParen < 0
  ) {
    return null;
  }

  let end =
    closeParen + 1;

  while (
    end < fragment.length &&
    /\s/.test(
      fragment[end]
    )
  ) {
    end++;
  }

  if (
    fragment[end] === ";"
  ) {
    end++;
  }

  return {
    statement:
      fragment
        .slice(
          statementStart,
          end
        )
        .trim(),

    startOffset:
      lineOffset +
      statementStart
  };
}

function extractFunctionDeclarationSource(
  source: string,
  functionName: string,
  statementStart: number
): string | null {

  const normalized =
    source.replace(
      /\r\n/g,
      "\n"
    );

  const before =
    normalized.slice(
      0,
      statementStart
    );

  const pattern =
    new RegExp(
      String.raw`(?:export\s+)?(?:async\s+)?function\s+${escapeRegExp(
        functionName
      )}\s*\(`,
      "g"
    );

  let lastIndex =
    -1;

  for (
    const match
    of before.matchAll(
      pattern
    )
  ) {

    if (
      match.index !== undefined
    ) {
      lastIndex =
        match.index;
    }
  }

  if (
    lastIndex < 0
  ) {
    return null;
  }

  /*
   * The transformer currently needs only the
   * function parameter declaration to verify that
   * operationId already exists.
   */
  return normalized.slice(
    lastIndex,
    Math.min(
      normalized.length,
      statementStart + 1
    )
  );
}

async function applyTransformerClassification(
  root: string,
  finding: Finding,
  candidate: ProtectionCandidate,
  provider: string | null,
  manifest: CapabilityManifest | null
): Promise<void> {

  if (
    !provider ||
    candidate.automation_status !==
      "PROVIDER_CAPABILITY_DECLARED" ||
    finding.category !==
      "HTTP_WRITE"
  ) {
    return;
  }

  const capability =
    manifest?.capabilities.find(
      item =>
        item.category ===
          "HTTP_WRITE" &&
        item.action_type ===
          "http_write_v1"
    );

  if (!capability) {
    return;
  }

  if (
    !/\.(?:ts|tsx|mts|cts)$/i.test(
      finding.file
    )
  ) {
    candidate.transformer_reason =
      "The proven HTTP transformer currently supports TypeScript source only.";

    return;
  }

  const sourcePath =
    path.resolve(
      root,
      finding.file
    );

  const relative =
    path.relative(
      root,
      sourcePath
    );

  if (
    relative.startsWith(
      ".."
    ) ||
    path.isAbsolute(
      relative
    )
  ) {
    candidate.transformer_reason =
      "Source path escaped the project root.";

    return;
  }

  let source:
    string;

  try {

    source =
      await fs.readFile(
        sourcePath,
        "utf8"
      );

  } catch {

    candidate.transformer_reason =
      "Source file could not be read.";

    return;
  }

  const extracted =
    extractAwaitFetchStatement(
      source,
      finding.line
    );

  if (!extracted) {

    candidate.transformer_reason =
      "No exact supported await fetch statement could be extracted.";

    return;
  }

  if (
    !finding.functionName
  ) {

    candidate.transformer_reason =
      "The supported transformer requires a named function containing the operation.";

    return;
  }

  const functionSource =
    extractFunctionDeclarationSource(
      source,
      finding.functionName,
      extracted.startOffset
    );

  if (!functionSource) {

    candidate.transformer_reason =
      "The surrounding supported function declaration could not be identified.";

    return;
  }

  const result =
    transformHttpWriteV1({
      statement:
        extracted.statement,

      functionSource,

      provider
    });

  if (!result.eligible) {

    candidate.transformer_reason =
      result.reason;

    return;
  }

  const allowedUrls =
    capability.allowed_urls;

  if (
    !Array.isArray(
      allowedUrls
    ) ||
    !allowedUrls.includes(
      result.url
    )
  ) {
    candidate.transformer_reason =
      `Capability does not explicitly allow target URL ${result.url}.`;

    return;
  }

  candidate.target_url =
    result.url;

  candidate.automation_status =
    "TRANSFORMER_MATCHED";

  candidate.automation_reason =
    "The exact source pattern was accepted by the proven ts_fetch_post_void_v1 transformer. Full source-patch planning is now being validated.";

  candidate.transformer_id =
    result.transformer;

  candidate.transformer_reason =
    "Exact transformer contract matched.";

  candidate.binding_required =
    result.requiresOnceBinding;

  const patchPlan =
    buildHttpWritePatchV1({
      source,
      statement:
        extracted.statement,
      functionSource,
      provider
    });

  if (
    !patchPlan.eligible
  ) {
    candidate.transformer_reason =
      `Transformer matched, but complete patch planning failed closed: ${patchPlan.reason}`;

    return;
  }

  candidate.automation_status =
    "PATCHABLE";

  candidate.automation_reason =
    "Scanner match, provider capability, transformer contract, call-site Once binding and deterministic full-source patch planning all succeeded.";

  candidate.auto_apply_eligible =
    true;

  candidate.binding_required =
    false;

  candidate.binding_strategy =
    patchPlan.bindingStrategy;

  candidate.patch_plan_id =
    patchPlan.patchPlan;

  candidate.source_sha256 =
    patchPlan.sourceSha256;

  candidate.proposed_source_sha256 =
    patchPlan.proposedSourceSha256;

  candidate.transformer_reason =
    "Complete deterministic source patch successfully planned in memory.";
}

export async function runProtect(
  requestedPath: string,
  options: ProtectOptions = {}
): Promise<void> {

  const root =
    path.resolve(
      requestedPath
    );

  const stat =
    await fs.stat(root);

  if (!stat.isDirectory()) {
    throw new Error(
      "Protect target must be a directory."
    );
  }

  const provider =
    await readProvider(root);

  const capabilityManifest =
    await readCapabilityManifest(
      root,
      provider
    );

  const files =
    await collectSourceFiles(root);

  const findings:
    Finding[] = [];

  for (
    const file of files
  ) {
    findings.push(
      ...await scanFile(
        root,
        file
      )
    );
  }

  findings.sort(
    (a, b) =>
      confidenceRank(
        a.confidence
      ) -
        confidenceRank(
          b.confidence
        ) ||
      a.file.localeCompare(
        b.file
      ) ||
      a.line - b.line
  );

  const selected =
    options.includeAll
      ? findings
      : findings.filter(
          finding =>
            finding.confidence ===
            "HIGH"
        );

  const candidates =
    selected.map(
      finding =>
        toCandidate(
          finding,
          capabilityManifest
        )
    );

  for (
    let i = 0;
    i < candidates.length;
    i++
  ) {

    await applyTransformerClassification(
      root,
      selected[i],
      candidates[i],
      provider,
      capabilityManifest
    );
  }

  console.log("");
  console.log("Once Protect");
  console.log("============");

  console.log("");
  console.log(
    `Project: ${root}`
  );

  console.log(
    `Provider: ${
      provider ??
      "not configured"
    }`
  );

  console.log(
    `Capability manifest: ${
      capabilityManifest
        ? "loaded"
        : "not present"
    }`
  );

  console.log(
    "Mode: review plan"
  );

  console.log(
    "Application source changes: none"
  );

  console.log("");
  console.log(
    "PROTECTION CANDIDATES"
  );

  console.log(
    "---------------------"
  );

  if (
    candidates.length === 0
  ) {
    console.log(
      "No candidates selected."
    );

    if (
      !options.includeAll
    ) {
      console.log(
        "Use --all to include MEDIUM and LOW-confidence findings."
      );
    }

    return;
  }

  for (
    const candidate
    of candidates
  ) {

    console.log("");

    console.log(
      `${candidate.confidence}  ${candidate.file}:${candidate.line}`
    );

    if (
      candidate.function_name
    ) {
      console.log(
        `  Function: ${candidate.function_name}()`
      );
    }

    console.log(
      `  Category: ${candidate.category}`
    );

    console.log(
      `  Callsite ref: ${candidate.callsite_ref}`
    );

    console.log(
      `  ${candidate.reason}`
    );

    console.log(
      `  Automation: ${candidate.automation_status}`
    );

    console.log(
      `  Auto-apply eligible: ${
        candidate.auto_apply_eligible
          ? "yes"
          : "no"
      }`
    );

    if (
      candidate.transformer_id
    ) {
      console.log(
        `  Transformer: ${candidate.transformer_id}`
      );

      console.log(
        `  Once binding required: ${
          candidate.binding_required
            ? "yes"
            : "no"
        }`
      );
    }
  }

  console.log("");
  console.log(
    "OPERATION ID RULE"
  );

  console.log(
    "-----------------"
  );

  console.log(
    "The callsite reference is NOT an operation ID."
  );

  console.log(
    "Each real-world action needs its own stable operationId."
  );

  console.log(
    "A retry of that same action must reuse the same operationId."
  );

  if (provider) {
    console.log("");

    console.log(
      `Configured provider: ${provider}`
    );
  }

  const onceDirectory =
    path.join(
      root,
      ".once"
    );

  if (
    options.writePatch ||
    options.writePlan ||
    options.writeSnippets
  ) {
    await fs.mkdir(
      onceDirectory,
      {
        recursive: true
      }
    );
  }

  if (
    options.writeSnippets
  ) {

    const snippetsDirectory =
      path.join(
        onceDirectory,
        "protect-snippets"
      );

    await fs.mkdir(
      snippetsDirectory,
      {
        recursive: true
      }
    );

    for (
      const candidate
      of candidates
    ) {

      const snippetPath =
        path.join(
          snippetsDirectory,
          safeFileName(
            candidate
          )
        );

      await fs.writeFile(
        snippetPath,
        buildIntegrationSnippet(
          candidate,
          provider
        ),
        "utf8"
      );
    }

    console.log("");
    console.log(
      "Integration snippets written:"
    );

    console.log(
      snippetsDirectory
    );

    console.log(
      `${candidates.length} review snippet${
        candidates.length === 1
          ? ""
          : "s"
      } generated.`
    );

    console.log(
      "Application source files were NOT modified."
    );
  }

  if (
    options.writePatch
  ) {

    const patchPath =
      path.join(
        onceDirectory,
        "protect-preview.diff"
      );

    const patchText =
      candidates
        .map(
          candidate =>
            buildPatchPreview(
              candidate,
              provider
            )
        )
        .join("\n");

    await fs.writeFile(
      patchPath,
      patchText,
      "utf8"
    );

    console.log("");
    console.log(
      "Patch preview written:"
    );

    console.log(
      patchPath
    );

    console.log(
      "This is a review artifact only."
    );

    console.log(
      "Application source files were NOT modified."
    );
  }

  if (
    options.writePlan
  ) {

    const plan:
      ProtectPlan = {

      schema_version:
        1,

      generated_at:
        new Date()
          .toISOString(),

      project:
        root,

      provider,

      source_modified:
        false,

      candidates
    };

    const planPath =
      path.join(
        onceDirectory,
        "protect-plan.json"
      );

    await fs.writeFile(
      planPath,
      JSON.stringify(
        plan,
        null,
        2
      ) + "\n",
      "utf8"
    );

    console.log("");
    console.log(
      "Protection plan written:"
    );

    console.log(
      planPath
    );

    console.log(
      "No application source files were modified."
    );
  }

  if (
    !options.writePlan &&
    !options.writePatch &&
    !options.writeSnippets
  ) {
    console.log("");

    console.log(
      "Preview only."
    );

    console.log(
      "Use --write-plan to save the structured review plan."
    );

    console.log(
      "Use --patch to generate a reviewable diff artifact."
    );

    console.log(
      "Use --snippets to generate integration guidance per callsite."
    );
  }
}
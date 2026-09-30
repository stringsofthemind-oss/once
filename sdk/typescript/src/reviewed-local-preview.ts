import { createHash } from "node:crypto";
import path from "node:path";

import {
  validateReviewedLocalSemanticsPlan,
  type ReviewedLocalSemanticsPlan,
} from "./reviewed-local-semantics.js";

export type ReviewedLocalProtectionPreview = Readonly<{
  schema_version: 1;
  kind: "reviewed_local_protection_preview_v1";
  source_modified: false;
  generated_file_written: false;
  runnable: false;
  target: Readonly<{
    file: string;
    function_name: string;
    source_sha256: string;
    review_fingerprint: string;
  }>;
  output: Readonly<{
    file: string;
    module_sha256: string;
    module_source: string;
  }>;
}>;

function sha256(value: string): string {
  return createHash("sha256")
    .update(value.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

function reviewFingerprint(plan: ReviewedLocalSemanticsPlan): string {
  return sha256(JSON.stringify({
    file: plan.target.file,
    function_name: plan.target.function_name,
    source_sha256: plan.target.source_sha256,
    identity: plan.review.identity,
    payload: plan.review.payload,
  }));
}

function generatedFile(plan: ReviewedLocalSemanticsPlan): string {
  const digest = sha256(
    `${plan.target.file}\u0000${plan.target.function_name}`,
  ).slice(0, 12);
  const safeName = plan.target.function_name
    .replace(/[^A-Za-z0-9_$-]+/g, "-")
    .slice(0, 80);
  return `.once/generated/${safeName}-${digest}.once.mjs`;
}

function importSpecifier(
  root: string,
  outputFile: string,
  targetFile: string,
): string {
  const fromDirectory = path.dirname(path.resolve(root, outputFile));
  const targetPath = path.resolve(root, targetFile);
  let relative = path.relative(fromDirectory, targetPath).replaceAll("\\", "/");
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

function propertyExpression(root: string, reviewedPath: string): string {
  return reviewedPath
    .split(".")
    .reduce(
      (expression, segment) => `${expression}[${JSON.stringify(segment)}]`,
      root,
    );
}

async function assertGeneratedModuleParses(source: string): Promise<void> {
  const ts = await import("typescript");
  const result = ts.transpileModule(source, {
    fileName: "reviewed-local-protection-preview.mjs",
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
    },
  });
  const errors = (result.diagnostics ?? []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      "Reviewed local protection preview did not parse successfully. No generated file was written.",
    );
  }
}

function buildModuleSource(
  root: string,
  plan: ReviewedLocalSemanticsPlan,
  outputFile: string,
): string {
  const originalImport = importSpecifier(root, outputFile, plan.target.file);
  const functionName = plan.target.function_name;
  const idValue = propertyExpression("input", plan.review.identity.path);
  const payloadEntries = plan.review.payload.paths.map(
    reviewedPath =>
      `      ${JSON.stringify(reviewedPath)}: ${propertyExpression("input", reviewedPath)},`,
  );

  return [
    "// Generated preview from developer-reviewed Once semantics.",
    "// This file has not been written by Once and is not active application code.",
    'import { Once as __OnceAgentId, protectLocal as __OnceProtectLocal } from "@once-agent/sdk";',
    `import { ${functionName} as __OnceOriginal } from ${JSON.stringify(originalImport)};`,
    "",
    `export const ${functionName} = __OnceProtectLocal(`,
    "  __OnceOriginal,",
    "  {",
    `    id: input => __OnceAgentId.id(${JSON.stringify(plan.review.identity.prefix)}, ${idValue}),`,
    "    payload: input => ({",
    ...payloadEntries,
    "    }),",
    "  },",
    ");",
    "",
  ].join("\n");
}

export async function buildReviewedLocalProtectionPreview(
  requestedPath: string,
): Promise<ReviewedLocalProtectionPreview> {
  const root = path.resolve(requestedPath);
  const plan = await validateReviewedLocalSemanticsPlan(root);

  if (path.extname(plan.target.file).toLowerCase() !== ".mjs") {
    throw new Error(
      "Reviewed local protection preview v1 supports only an explicit ESM .mjs target. The reviewed semantics remain recorded, but no generated code was produced.",
    );
  }

  const outputFile = generatedFile(plan);
  const moduleSource = buildModuleSource(root, plan, outputFile);
  await assertGeneratedModuleParses(moduleSource);

  return {
    schema_version: 1,
    kind: "reviewed_local_protection_preview_v1",
    source_modified: false,
    generated_file_written: false,
    runnable: false,
    target: {
      file: plan.target.file,
      function_name: plan.target.function_name,
      source_sha256: plan.target.source_sha256,
      review_fingerprint: reviewFingerprint(plan),
    },
    output: {
      file: outputFile,
      module_sha256: sha256(moduleSource),
      module_source: moduleSource,
    },
  };
}

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildReviewedLocalProtectionPreview,
} from "./reviewed-local-preview.js";

export type ReviewedLocalCallerInventory = Readonly<{
  schema_version: 1;
  kind: "reviewed_local_caller_inventory_v1";
  source_modified: false;
  generated_file_modified: false;
  application_wired: false;
  status: "READY_FOR_ROUTING_REVIEW" | "NO_DIRECT_CALLERS" | "BLOCKED";
  project: string;
  target: Readonly<{
    file: string;
    function_name: string;
    source_sha256: string;
    review_fingerprint: string;
  }>;
  companion: Readonly<{
    file: string;
    module_sha256: string;
    verified_materialized: true;
  }>;
  scope: Readonly<{
    source_extensions: readonly string[];
    ignored_directories: readonly string[];
    proof_boundary: "exact_relative_esm_imports_only";
  }>;
  callers: readonly ReviewedLocalCaller[];
  blockers: readonly ReviewedLocalCallerBlocker[];
}>;

export type ReviewedLocalCaller = Readonly<{
  file: string;
  source_sha256: string;
  import: Readonly<{
    module_specifier: string;
    imported_name: string;
    local_name: string;
    imported_with_other_bindings: boolean;
    start: number;
    end: number;
    line: number;
    column: number;
  }>;
  call_sites: readonly Readonly<{
    local_name: string;
    start: number;
    end: number;
    line: number;
    column: number;
    call_sha256: string;
  }>[];
}>;

export type ReviewedLocalCallerBlocker = Readonly<{
  file: string;
  kind:
    | "SYMLINK_ENTRY"
    | "TARGET_REEXPORT"
    | "TARGET_DYNAMIC_IMPORT"
    | "UNSUPPORTED_TARGET_IMPORT"
    | "DUPLICATE_TARGET_IMPORT"
    | "SHADOWED_TARGET_BINDING"
    | "NON_DIRECT_TARGET_REFERENCE";
  reason: string;
  line: number | null;
  column: number | null;
}>;

const SOURCE_EXTENSIONS = [
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
] as const;

const SOURCE_EXTENSION_SET = new Set<string>(SOURCE_EXTENSIONS);
const IGNORED_DIRECTORIES = [".git", ".once", "node_modules"] as const;
const IGNORED_DIRECTORY_SET = new Set<string>(IGNORED_DIRECTORIES);

function sha256(value: string): string {
  return createHash("sha256")
    .update(value.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must remain inside the selected project.`);
  }
}

function normalizedRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).replaceAll("\\", "/");
}

function sourceLocation(
  sourceFile: import("typescript").SourceFile,
  node: import("typescript").Node,
): { line: number; column: number } {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    line: location.line + 1,
    column: location.character + 1,
  };
}

function resolvesExactlyToTarget(
  callerPath: string,
  moduleSpecifier: string,
  targetPath: string,
): boolean {
  if (!moduleSpecifier.startsWith("./") && !moduleSpecifier.startsWith("../")) {
    return false;
  }
  return path.resolve(path.dirname(callerPath), moduleSpecifier) === targetPath;
}

function bindingNameContains(
  ts: typeof import("typescript"),
  name: import("typescript").BindingName,
  expected: string,
): boolean {
  if (ts.isIdentifier(name)) return name.text === expected;
  return name.elements.some(element =>
    !ts.isOmittedExpression(element) && bindingNameContains(ts, element.name, expected)
  );
}

function isRuntimeBindingDeclaration(
  ts: typeof import("typescript"),
  node: import("typescript").Node,
  localName: string,
  acceptedImport: import("typescript").ImportSpecifier,
): boolean {
  if (node === acceptedImport || node === acceptedImport.name || node === acceptedImport.propertyName) {
    return false;
  }

  if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
    return bindingNameContains(ts, node.name, localName);
  }

  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)) &&
    node.name?.text === localName
  ) {
    return true;
  }

  if (ts.isCatchClause(node) && node.variableDeclaration) {
    return bindingNameContains(ts, node.variableDeclaration.name, localName);
  }

  if (ts.isImportClause(node) && node.name?.text === localName) {
    return true;
  }

  if (ts.isImportSpecifier(node) && node !== acceptedImport && node.name.text === localName) {
    return true;
  }

  if (ts.isNamespaceImport(node) && node.name.text === localName) {
    return true;
  }

  return false;
}

function identifierIsSyntaxOnly(
  ts: typeof import("typescript"),
  node: import("typescript").Identifier,
  acceptedImport: import("typescript").ImportSpecifier,
): boolean {
  if (node === acceptedImport.name || node === acceptedImport.propertyName) return true;
  const parent = node.parent;

  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if (ts.isMethodSignature(parent) && parent.name === node) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  if (ts.isBreakStatement(parent) && parent.label === node) return true;
  if (ts.isContinueStatement(parent) && parent.label === node) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;

  return false;
}

async function verifyMaterializedCompanion(
  root: string,
  realRoot: string,
): Promise<Awaited<ReturnType<typeof buildReviewedLocalProtectionPreview>>> {
  const preview = await buildReviewedLocalProtectionPreview(root);
  const outputPath = path.resolve(root, preview.output.file);
  assertContained(realRoot, outputPath, "Reviewed local generated companion");

  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "Verified caller inventory requires the reviewed companion to be materialized first. Run review-local --materialize --confirm-materialize after reviewing the preview.",
      );
    }
    throw error;
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      "Reviewed local generated companion must be a regular non-symlink file before caller inventory can proceed.",
    );
  }

  const realOutput = await fs.realpath(outputPath);
  assertContained(realRoot, realOutput, "Reviewed local generated companion");
  const source = await fs.readFile(outputPath, "utf8");
  if (sha256(source) !== preview.output.module_sha256) {
    throw new Error(
      "Materialized reviewed companion differs from the reviewed deterministic preview. Refusing caller inventory.",
    );
  }

  return preview;
}

async function collectProjectSources(
  root: string,
): Promise<{
  files: string[];
  blockers: ReviewedLocalCallerBlocker[];
}> {
  const files: string[] = [];
  const blockers: ReviewedLocalCallerBlocker[] = [];

  const walk = async (directory: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (IGNORED_DIRECTORY_SET.has(entry.name) && entry.isDirectory()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = normalizedRelative(root, absolute);

      if (entry.isSymbolicLink()) {
        blockers.push({
          file: relative,
          kind: "SYMLINK_ENTRY",
          reason:
            "Caller inventory does not traverse symlinked project entries because their source identity is not statically contained.",
          line: null,
          column: null,
        });
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      if (
        entry.isFile() &&
        SOURCE_EXTENSION_SET.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(absolute);
      }
    }
  };

  await walk(root);
  files.sort((a, b) => normalizedRelative(root, a).localeCompare(normalizedRelative(root, b)));
  return { files, blockers };
}

async function inspectCallerFile(
  root: string,
  filePath: string,
  targetPath: string,
  functionName: string,
): Promise<{
  callers: ReviewedLocalCaller[];
  blockers: ReviewedLocalCallerBlocker[];
}> {
  const ts = await import("typescript");
  const source = await fs.readFile(filePath, "utf8");
  const file = normalizedRelative(root, filePath);
  const sourceSha = sha256(source);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const blockers: ReviewedLocalCallerBlocker[] = [];
  const targetImports: import("typescript").ImportSpecifier[] = [];
  const targetImportDeclarations: import("typescript").ImportDeclaration[] = [];

  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      resolvesExactlyToTarget(filePath, statement.moduleSpecifier.text, targetPath)
    ) {
      const exportsTarget =
        !statement.exportClause ||
        (ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.some(element =>
            (element.propertyName?.text ?? element.name.text) === functionName
          ));
      if (exportsTarget) {
        const location = sourceLocation(sourceFile, statement);
        blockers.push({
          file,
          kind: "TARGET_REEXPORT",
          reason:
            "The reviewed target is re-exported. Indirect downstream callers are outside caller-inventory v1 and must not be guessed.",
          ...location,
        });
      }
    }

    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !resolvesExactlyToTarget(filePath, statement.moduleSpecifier.text, targetPath)
    ) {
      continue;
    }

    const importClause = statement.importClause;
    if (!importClause || importClause.isTypeOnly) continue;
    const namedBindings = importClause.namedBindings;

    if (importClause.name || !namedBindings || ts.isNamespaceImport(namedBindings)) {
      const location = sourceLocation(sourceFile, statement);
      blockers.push({
        file,
        kind: "UNSUPPORTED_TARGET_IMPORT",
        reason:
          "Caller inventory v1 supports the reviewed target only through an exact static named ESM import, not default or namespace imports.",
        ...location,
      });
      continue;
    }

    const matches = namedBindings.elements.filter(element =>
      !element.isTypeOnly &&
      (element.propertyName?.text ?? element.name.text) === functionName
    );
    if (matches.length === 0) continue;
    targetImports.push(...matches);
    targetImportDeclarations.push(statement);
  }

  const visitDynamicImports = (node: import("typescript").Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!) &&
      resolvesExactlyToTarget(filePath, node.arguments[0]!.text, targetPath)
    ) {
      const location = sourceLocation(sourceFile, node);
      blockers.push({
        file,
        kind: "TARGET_DYNAMIC_IMPORT",
        reason:
          "The reviewed target is reached through dynamic import(). Caller inventory v1 does not infer dynamic routing.",
        ...location,
      });
    }
    ts.forEachChild(node, visitDynamicImports);
  };
  visitDynamicImports(sourceFile);

  if (targetImports.length > 1) {
    const location = sourceLocation(sourceFile, targetImports[1]!);
    blockers.push({
      file,
      kind: "DUPLICATE_TARGET_IMPORT",
      reason:
        "The reviewed function is imported more than once in one module. Caller inventory v1 refuses duplicate bindings.",
      ...location,
    });
    return { callers: [], blockers };
  }

  if (targetImports.length === 0) return { callers: [], blockers };

  const acceptedImport = targetImports[0]!;
  const declaration = targetImportDeclarations[0]!;
  const localName = acceptedImport.name.text;

  let shadowed = false;
  const findShadow = (node: import("typescript").Node): void => {
    if (shadowed) return;
    if (isRuntimeBindingDeclaration(ts, node, localName, acceptedImport)) {
      shadowed = true;
      const location = sourceLocation(sourceFile, node);
      blockers.push({
        file,
        kind: "SHADOWED_TARGET_BINDING",
        reason:
          `The imported reviewed target binding ${JSON.stringify(localName)} is shadowed by another runtime binding. Refusing ambiguous caller identity.`,
        ...location,
      });
      return;
    }
    ts.forEachChild(node, findShadow);
  };
  findShadow(sourceFile);
  if (shadowed) return { callers: [], blockers };

  const callSites: ReviewedLocalCaller["call_sites"][number][] = [];
  const nonDirectReferences: import("typescript").Identifier[] = [];
  const visitReferences = (node: import("typescript").Node): void => {
    if (ts.isIdentifier(node) && node.text === localName) {
      if (identifierIsSyntaxOnly(ts, node, acceptedImport)) return;
      if (node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        const call = node.parent;
        const location = sourceLocation(sourceFile, call);
        callSites.push({
          local_name: localName,
          start: call.getStart(sourceFile),
          end: call.end,
          ...location,
          call_sha256: sha256(source.slice(call.getStart(sourceFile), call.end)),
        });
        return;
      }
      if (!isRuntimeBindingDeclaration(ts, node, localName, acceptedImport)) {
        nonDirectReferences.push(node);
      }
      return;
    }
    ts.forEachChild(node, visitReferences);
  };
  visitReferences(sourceFile);

  if (nonDirectReferences.length > 0) {
    const first = nonDirectReferences[0]!;
    const location = sourceLocation(sourceFile, first);
    blockers.push({
      file,
      kind: "NON_DIRECT_TARGET_REFERENCE",
      reason:
        `The imported reviewed target binding ${JSON.stringify(localName)} is used outside a direct call expression. Caller inventory v1 does not guess indirect dispatch, registries, callbacks, .call/.bind, or value flow.`,
      ...location,
    });
    return { callers: [], blockers };
  }

  if (callSites.length === 0) return { callers: [], blockers };

  const moduleSpecifier = (declaration.moduleSpecifier as import("typescript").StringLiteralLike).text;
  const location = sourceLocation(sourceFile, declaration);
  const namedBindings = declaration.importClause?.namedBindings;
  const importedWithOtherBindings =
    Boolean(declaration.importClause?.name) ||
    (namedBindings && ts.isNamedImports(namedBindings)
      ? namedBindings.elements.length > 1
      : false);

  callSites.sort((a, b) => a.start - b.start);
  return {
    callers: [
      {
        file,
        source_sha256: sourceSha,
        import: {
          module_specifier: moduleSpecifier,
          imported_name: functionName,
          local_name: localName,
          imported_with_other_bindings: Boolean(importedWithOtherBindings),
          start: declaration.getStart(sourceFile),
          end: declaration.end,
          ...location,
        },
        call_sites: callSites,
      },
    ],
    blockers,
  };
}

export async function inventoryReviewedLocalCallers(
  requestedPath: string,
): Promise<ReviewedLocalCallerInventory> {
  const root = path.resolve(requestedPath);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error("Reviewed caller inventory project target must be a directory.");
  }

  const realRoot = await fs.realpath(root);
  const preview = await verifyMaterializedCompanion(root, realRoot);
  const targetPath = path.resolve(root, preview.target.file);
  const targetRealPath = await fs.realpath(targetPath);
  assertContained(realRoot, targetRealPath, "Reviewed local target source");

  const collected = await collectProjectSources(root);
  const callers: ReviewedLocalCaller[] = [];
  const blockers: ReviewedLocalCallerBlocker[] = [...collected.blockers];

  for (const filePath of collected.files) {
    if (path.resolve(filePath) === targetPath) continue;
    const inspected = await inspectCallerFile(
      root,
      filePath,
      targetPath,
      preview.target.function_name,
    );
    callers.push(...inspected.callers);
    blockers.push(...inspected.blockers);
  }

  callers.sort((a, b) =>
    a.file.localeCompare(b.file) || a.import.start - b.import.start
  );
  blockers.sort((a, b) =>
    a.file.localeCompare(b.file) ||
    (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
    (a.column ?? Number.MAX_SAFE_INTEGER) - (b.column ?? Number.MAX_SAFE_INTEGER) ||
    a.kind.localeCompare(b.kind)
  );

  const status = blockers.length > 0
    ? "BLOCKED"
    : callers.length > 0
      ? "READY_FOR_ROUTING_REVIEW"
      : "NO_DIRECT_CALLERS";

  return {
    schema_version: 1,
    kind: "reviewed_local_caller_inventory_v1",
    source_modified: false,
    generated_file_modified: false,
    application_wired: false,
    status,
    project: root,
    target: {
      file: preview.target.file,
      function_name: preview.target.function_name,
      source_sha256: preview.target.source_sha256,
      review_fingerprint: preview.target.review_fingerprint,
    },
    companion: {
      file: preview.output.file,
      module_sha256: preview.output.module_sha256,
      verified_materialized: true,
    },
    scope: {
      source_extensions: SOURCE_EXTENSIONS,
      ignored_directories: IGNORED_DIRECTORIES,
      proof_boundary: "exact_relative_esm_imports_only",
    },
    callers,
    blockers,
  };
}

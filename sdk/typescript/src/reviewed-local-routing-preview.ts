import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  inventoryReviewedLocalCallers,
  type ReviewedLocalCallerInventory,
} from "./reviewed-local-caller-inventory.js";

export type ReviewedLocalRoutingPreview = Readonly<{
  schema_version: 1;
  kind: "reviewed_local_routing_preview_v1";
  source_modified: false;
  generated_file_modified: false;
  application_wired: false;
  status: "PATCHABLE_PREVIEW" | "NO_DIRECT_CALLERS" | "BLOCKED";
  project: string;
  inventory_fingerprint: string;
  target: ReviewedLocalCallerInventory["target"];
  companion: ReviewedLocalCallerInventory["companion"];
  routes: readonly ReviewedLocalRoutingRoute[];
  blockers: readonly ReviewedLocalRoutingBlocker[];
}>;

export type ReviewedLocalRoutingRoute = Readonly<{
  file: string;
  source_sha256: string;
  result_source_sha256: string;
  imported_name: string;
  local_name: string;
  direct_call_count: number;
  import_line: number;
  replacement: Readonly<{
    start: number;
    end: number;
    line: number;
    column: number;
    before: string;
    after: string;
    before_sha256: string;
    after_sha256: string;
  }>;
}>;

export type ReviewedLocalRoutingBlocker = Readonly<{
  file: string;
  kind:
    | "INVENTORY_BLOCKED"
    | "MIXED_IMPORT_BINDINGS"
    | "STALE_CALLER_EVIDENCE"
    | "IMPORT_EVIDENCE_MISMATCH"
    | "UNSAFE_MODULE_SPECIFIER";
  reason: string;
  line: number | null;
  column: number | null;
}>;

function sha256(value: string): string {
  return createHash("sha256")
    .update(value.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

function inventoryFingerprint(inventory: ReviewedLocalCallerInventory): string {
  return sha256(JSON.stringify({
    schema_version: inventory.schema_version,
    kind: inventory.kind,
    target: inventory.target,
    companion: inventory.companion,
    scope: inventory.scope,
    callers: inventory.callers,
    blockers: inventory.blockers,
  }));
}

function companionSpecifier(
  root: string,
  callerFile: string,
  companionFile: string,
): string {
  const callerDirectory = path.dirname(path.resolve(root, callerFile));
  const companionPath = path.resolve(root, companionFile);
  let relative = path.relative(callerDirectory, companionPath).replaceAll("\\", "/");
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

function renderModuleLiteral(rawLiteral: string, value: string): string | undefined {
  const quote = rawLiteral[0];
  if ((quote !== '"' && quote !== "'") || rawLiteral.at(-1) !== quote) {
    return undefined;
  }
  if (value.includes(quote) || /[\r\n]/.test(value)) return undefined;
  return `${quote}${value}${quote}`;
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

async function buildRoute(
  root: string,
  inventory: ReviewedLocalCallerInventory,
  caller: ReviewedLocalCallerInventory["callers"][number],
): Promise<{
  route?: ReviewedLocalRoutingRoute;
  blocker?: ReviewedLocalRoutingBlocker;
}> {
  if (caller.import.imported_with_other_bindings) {
    return {
      blocker: {
        file: caller.file,
        kind: "MIXED_IMPORT_BINDINGS",
        reason:
          "Routing preview v1 will not retarget an import declaration that also carries other bindings. Splitting imports is a separate source transformation and is not guessed here.",
        line: caller.import.line,
        column: caller.import.column,
      },
    };
  }

  const sourcePath = path.resolve(root, caller.file);
  const source = await fs.readFile(sourcePath, "utf8");
  if (sha256(source) !== caller.source_sha256) {
    return {
      blocker: {
        file: caller.file,
        kind: "STALE_CALLER_EVIDENCE",
        reason:
          "Caller source changed after inventory evidence was produced. Refusing to preview a routing change from stale evidence.",
        line: caller.import.line,
        column: caller.import.column,
      },
    };
  }

  const ts = await import("typescript");
  const sourceFile = ts.createSourceFile(
    caller.file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const matches = sourceFile.statements.filter(statement => {
    if (!ts.isImportDeclaration(statement)) return false;
    if (statement.getStart(sourceFile) !== caller.import.start || statement.end !== caller.import.end) {
      return false;
    }
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) return false;
    if (statement.moduleSpecifier.text !== caller.import.module_specifier) return false;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) return false;
    if (statement.importClause?.name || statement.importClause?.isTypeOnly) return false;
    if (named.elements.length !== 1) return false;
    const element = named.elements[0]!;
    return (
      !element.isTypeOnly &&
      (element.propertyName?.text ?? element.name.text) === caller.import.imported_name &&
      element.name.text === caller.import.local_name
    );
  });

  if (matches.length !== 1) {
    return {
      blocker: {
        file: caller.file,
        kind: "IMPORT_EVIDENCE_MISMATCH",
        reason:
          "Caller import no longer resolves to the exact single-binding import proven by inventory. Refusing routing preview.",
        line: caller.import.line,
        column: caller.import.column,
      },
    };
  }

  const declaration = matches[0] as import("typescript").ImportDeclaration;
  const moduleSpecifier = declaration.moduleSpecifier;
  const before = source.slice(moduleSpecifier.getStart(sourceFile), moduleSpecifier.end);
  const nextSpecifier = companionSpecifier(root, caller.file, inventory.companion.file);
  const after = renderModuleLiteral(before, nextSpecifier);

  if (after === undefined) {
    const location = sourceLocation(sourceFile, moduleSpecifier);
    return {
      blocker: {
        file: caller.file,
        kind: "UNSAFE_MODULE_SPECIFIER",
        reason:
          "The exact module-specifier literal cannot be replaced without changing quoting semantics. Refusing routing preview.",
        ...location,
      },
    };
  }

  const start = moduleSpecifier.getStart(sourceFile);
  const end = moduleSpecifier.end;
  const resultSource = source.slice(0, start) + after + source.slice(end);
  const location = sourceLocation(sourceFile, moduleSpecifier);

  return {
    route: {
      file: caller.file,
      source_sha256: caller.source_sha256,
      result_source_sha256: sha256(resultSource),
      imported_name: caller.import.imported_name,
      local_name: caller.import.local_name,
      direct_call_count: caller.call_sites.length,
      import_line: caller.import.line,
      replacement: {
        start,
        end,
        ...location,
        before,
        after,
        before_sha256: sha256(before),
        after_sha256: sha256(after),
      },
    },
  };
}

export async function buildReviewedLocalRoutingPreview(
  requestedPath: string,
): Promise<ReviewedLocalRoutingPreview> {
  const root = path.resolve(requestedPath);
  const inventory = await inventoryReviewedLocalCallers(root);
  const fingerprint = inventoryFingerprint(inventory);

  if (inventory.status === "BLOCKED") {
    return {
      schema_version: 1,
      kind: "reviewed_local_routing_preview_v1",
      source_modified: false,
      generated_file_modified: false,
      application_wired: false,
      status: "BLOCKED",
      project: root,
      inventory_fingerprint: fingerprint,
      target: inventory.target,
      companion: inventory.companion,
      routes: [],
      blockers: inventory.blockers.map(blocker => ({
        file: blocker.file,
        kind: "INVENTORY_BLOCKED" as const,
        reason: `${blocker.kind}: ${blocker.reason}`,
        line: blocker.line,
        column: blocker.column,
      })),
    };
  }

  if (inventory.status === "NO_DIRECT_CALLERS") {
    return {
      schema_version: 1,
      kind: "reviewed_local_routing_preview_v1",
      source_modified: false,
      generated_file_modified: false,
      application_wired: false,
      status: "NO_DIRECT_CALLERS",
      project: root,
      inventory_fingerprint: fingerprint,
      target: inventory.target,
      companion: inventory.companion,
      routes: [],
      blockers: [],
    };
  }

  const routes: ReviewedLocalRoutingRoute[] = [];
  const blockers: ReviewedLocalRoutingBlocker[] = [];

  for (const caller of inventory.callers) {
    const built = await buildRoute(root, inventory, caller);
    if (built.route) routes.push(built.route);
    if (built.blocker) blockers.push(built.blocker);
  }

  routes.sort((a, b) =>
    a.file.localeCompare(b.file) || a.replacement.start - b.replacement.start
  );
  blockers.sort((a, b) =>
    a.file.localeCompare(b.file) ||
    (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
    (a.column ?? Number.MAX_SAFE_INTEGER) - (b.column ?? Number.MAX_SAFE_INTEGER) ||
    a.kind.localeCompare(b.kind)
  );

  return {
    schema_version: 1,
    kind: "reviewed_local_routing_preview_v1",
    source_modified: false,
    generated_file_modified: false,
    application_wired: false,
    status: blockers.length > 0 ? "BLOCKED" : "PATCHABLE_PREVIEW",
    project: root,
    inventory_fingerprint: fingerprint,
    target: inventory.target,
    companion: inventory.companion,
    routes: blockers.length > 0 ? [] : routes,
    blockers,
  };
}

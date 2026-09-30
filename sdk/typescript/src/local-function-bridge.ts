import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { scanFile } from "./scan.js";
import {
  analyzeLocalFunctionV1,
  buildLocalFunctionPatchV1,
  LOCAL_FUNCTION_PATCH_V1,
  LOCAL_FUNCTION_TRANSFORMER_V1,
} from "./transformers/local-function-v1.js";

export const LOCAL_FUNCTION_BRIDGE_PLAN_FILE =
  "local-function-protect-plan.json" as const;

export type LocalFunctionBridgeSelection = Readonly<{
  target: string;
  idPrefix: string;
  idField: string;
}>;

export type LocalFunctionBridgePlan = Readonly<{
  schema_version: 1;
  kind: "local_function_v1";
  generated_at: string;
  project: string;
  source_modified: false;
  target: Readonly<{
    file: string;
    function_name: string;
    category: "BOOKING";
    finding_line: number;
    transformer_id: typeof LOCAL_FUNCTION_TRANSFORMER_V1;
    patch_plan_id: typeof LOCAL_FUNCTION_PATCH_V1;
    id_prefix: string;
    id_field: string;
    input_fields: string[];
    binding_strategy: "esm_import_protect_local_v1";
    source_sha256: string;
    proposed_source_sha256: string;
  }>;
}>;

export type LocalFunctionBridgeApplyResult = Readonly<{
  file: string;
  functionName: string;
  backupPath: string;
  sourceSha256: string;
  appliedSha256: string;
}>;

type ParsedTarget = Readonly<{
  file: string;
  functionName: string;
  sourcePath: string;
}>;

function sha256(value: string): string {
  return createHash("sha256")
    .update(value.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

function assertProjectRoot(root: string, sourcePath: string): void {
  const relative = path.relative(root, sourcePath);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      "Local-function bridge target must be a project-relative source file inside the selected project.",
    );
  }
}

async function assertRegularContainedFile(
  root: string,
  sourcePath: string,
): Promise<void> {
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      "Local-function bridge target must be a regular non-symlink source file.",
    );
  }

  const [realRoot, realSource] = await Promise.all([
    fs.realpath(root),
    fs.realpath(sourcePath),
  ]);
  assertProjectRoot(realRoot, realSource);
}

function parseTarget(root: string, value: string): ParsedTarget {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      "Local-function bridge target must be explicit file:function, for example orders.mjs:createOrder.",
    );
  }

  const fileValue = value.slice(0, separator).trim();
  const functionName = value.slice(separator + 1).trim();

  if (!fileValue || path.isAbsolute(fileValue)) {
    throw new Error(
      "Local-function bridge target file must be project-relative, not absolute.",
    );
  }

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(functionName)) {
    throw new Error(
      "Local-function bridge target function must be one simple identifier.",
    );
  }

  const sourcePath = path.resolve(root, fileValue);
  assertProjectRoot(root, sourcePath);

  return {
    file: path.relative(root, sourcePath).replaceAll("\\", "/"),
    functionName,
    sourcePath,
  };
}

function assertSupportedLocalRuntime(): void {
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map(Number);

  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error(
      "Local-function bridge apply requires Node.js 24.15 or later because the generated protection uses durable local SQLite state. Source was not modified.",
    );
  }
}

async function verifyJavaScriptSource(
  source: string,
  fileName: string,
): Promise<void> {
  const ts = await import("typescript");
  const result = ts.transpileModule(source, {
    fileName,
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
    const message = errors
      .map(diagnostic =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      )
      .join("\n");

    throw new Error(
      "Generated local-function protection does not parse successfully:\n" +
        message,
    );
  }
}

async function resolvePinnedBookingFinding(input: {
  root: string;
  sourcePath: string;
  file: string;
  functionName: string;
  source: string;
}): Promise<number> {
  const findings = await scanFile(input.root, input.sourcePath);

  const eligibleLines = new Set<number>();
  const rejectionReasons = new Set<string>();

  for (const finding of findings) {
    if (finding.category !== "BOOKING") continue;

    const analysis = analyzeLocalFunctionV1({
      source: input.source,
      fileName: input.file,
      functionName: input.functionName,
      findingLine: finding.line,
      category: finding.category,
    });

    if (analysis.eligible) {
      eligibleLines.add(finding.line);
    } else {
      rejectionReasons.add(analysis.reason);
    }
  }

  if (eligibleLines.size === 0) {
    const detail = [...rejectionReasons][0];
    throw new Error(
      "Selected local function is not inside the pinned BOOKING/order bridge contract." +
        (detail ? ` ${detail}` : ""),
    );
  }

  if (eligibleLines.size !== 1) {
    throw new Error(
      "Selected local function matched more than one consequential BOOKING finding. Refusing an ambiguous source patch.",
    );
  }

  return [...eligibleLines][0]!;
}

async function buildPlanAndPatch(
  requestedPath: string,
  selection: LocalFunctionBridgeSelection,
): Promise<{
  plan: LocalFunctionBridgePlan;
  proposedSource: string;
}> {
  const root = path.resolve(requestedPath);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error("Local-function bridge project target must be a directory.");
  }

  const parsed = parseTarget(root, selection.target);
  await assertRegularContainedFile(root, parsed.sourcePath);
  const source = await fs.readFile(parsed.sourcePath, "utf8");
  const findingLine = await resolvePinnedBookingFinding({
    root,
    sourcePath: parsed.sourcePath,
    file: parsed.file,
    functionName: parsed.functionName,
    source,
  });

  const patch = buildLocalFunctionPatchV1({
    source,
    fileName: parsed.file,
    functionName: parsed.functionName,
    findingLine,
    category: "BOOKING",
    idField: selection.idField,
    idPrefix: selection.idPrefix,
  });

  if (!patch.eligible) {
    throw new Error(
      "Selected local function is not patchable under local-function bridge v1: " +
        patch.reason,
    );
  }

  await verifyJavaScriptSource(patch.proposedSource, parsed.sourcePath);

  return {
    plan: {
      schema_version: 1,
      kind: "local_function_v1",
      generated_at: new Date().toISOString(),
      project: root,
      source_modified: false,
      target: {
        file: parsed.file,
        function_name: parsed.functionName,
        category: "BOOKING",
        finding_line: findingLine,
        transformer_id: patch.transformer,
        patch_plan_id: patch.patchPlan,
        id_prefix: patch.idPrefix,
        id_field: patch.idField,
        input_fields: [...patch.inputFields],
        binding_strategy: patch.bindingStrategy,
        source_sha256: patch.sourceSha256,
        proposed_source_sha256: patch.proposedSourceSha256,
      },
    },
    proposedSource: patch.proposedSource,
  };
}

export async function planLocalFunctionBridge(
  requestedPath: string,
  selection: LocalFunctionBridgeSelection,
): Promise<LocalFunctionBridgePlan> {
  return (await buildPlanAndPatch(requestedPath, selection)).plan;
}

export async function writeLocalFunctionBridgePlan(
  requestedPath: string,
  selection: LocalFunctionBridgeSelection,
): Promise<LocalFunctionBridgePlan> {
  const root = path.resolve(requestedPath);
  const { plan } = await buildPlanAndPatch(root, selection);
  const onceDirectory = path.join(root, ".once");
  await fs.mkdir(onceDirectory, { recursive: true });
  await fs.writeFile(
    path.join(onceDirectory, LOCAL_FUNCTION_BRIDGE_PLAN_FILE),
    JSON.stringify(plan, null, 2) + "\n",
    "utf8",
  );
  return plan;
}

function isPlan(value: unknown): value is LocalFunctionBridgePlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const plan = value as Partial<LocalFunctionBridgePlan>;
  const target = plan.target as Partial<LocalFunctionBridgePlan["target"]> | undefined;

  return (
    plan.schema_version === 1 &&
    plan.kind === "local_function_v1" &&
    plan.source_modified === false &&
    typeof plan.project === "string" &&
    target !== undefined &&
    target.category === "BOOKING" &&
    target.transformer_id === LOCAL_FUNCTION_TRANSFORMER_V1 &&
    target.patch_plan_id === LOCAL_FUNCTION_PATCH_V1 &&
    typeof target.file === "string" &&
    typeof target.function_name === "string" &&
    typeof target.finding_line === "number" &&
    Number.isSafeInteger(target.finding_line) &&
    typeof target.id_prefix === "string" &&
    typeof target.id_field === "string" &&
    Array.isArray(target.input_fields) &&
    target.input_fields.every(item => typeof item === "string") &&
    target.binding_strategy === "esm_import_protect_local_v1" &&
    typeof target.source_sha256 === "string" &&
    typeof target.proposed_source_sha256 === "string"
  );
}

export async function applyLocalFunctionBridgePlan(
  requestedPath: string,
): Promise<LocalFunctionBridgeApplyResult> {
  assertSupportedLocalRuntime();

  const root = path.resolve(requestedPath);
  const onceDirectory = path.join(root, ".once");
  const planPath = path.join(onceDirectory, LOCAL_FUNCTION_BRIDGE_PLAN_FILE);
  const raw = await fs.readFile(planPath, "utf8");
  const parsedPlan: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));

  if (!isPlan(parsedPlan)) {
    throw new Error("Local-function bridge plan is malformed or outside v1.");
  }

  const plan = parsedPlan;
  if (path.resolve(plan.project) !== root) {
    throw new Error(
      "Local-function bridge plan project no longer matches the selected project.",
    );
  }

  const sourcePath = path.resolve(root, plan.target.file);
  assertProjectRoot(root, sourcePath);
  await assertRegularContainedFile(root, sourcePath);

  const originalSource = await fs.readFile(sourcePath, "utf8");
  if (sha256(originalSource) !== plan.target.source_sha256) {
    throw new Error(
      "Source changed after local-function bridge planning. Refusing stale patch.",
    );
  }

  const findings = await scanFile(root, sourcePath);
  const exactFinding = findings.filter(
    finding =>
      finding.category === "BOOKING" &&
      finding.line === plan.target.finding_line,
  );

  if (exactFinding.length !== 1) {
    throw new Error(
      "The exact planned BOOKING finding could not be re-established. Source was not modified.",
    );
  }

  const patch = buildLocalFunctionPatchV1({
    source: originalSource,
    fileName: plan.target.file,
    functionName: plan.target.function_name,
    findingLine: plan.target.finding_line,
    category: "BOOKING",
    idField: plan.target.id_field,
    idPrefix: plan.target.id_prefix,
  });

  if (!patch.eligible) {
    throw new Error(
      "Local-function bridge patch no longer satisfies the pinned contract: " +
        patch.reason,
    );
  }

  if (
    patch.sourceSha256 !== plan.target.source_sha256 ||
    patch.proposedSourceSha256 !== plan.target.proposed_source_sha256 ||
    patch.transformer !== plan.target.transformer_id ||
    patch.patchPlan !== plan.target.patch_plan_id ||
    patch.bindingStrategy !== plan.target.binding_strategy ||
    patch.idField !== plan.target.id_field ||
    patch.idPrefix !== plan.target.id_prefix ||
    JSON.stringify(patch.inputFields) !== JSON.stringify(plan.target.input_fields)
  ) {
    throw new Error(
      "Recomputed local-function patch differs from the reviewed plan. Refusing source mutation.",
    );
  }

  await verifyJavaScriptSource(patch.proposedSource, sourcePath);

  const backupDirectory = path.join(
    onceDirectory,
    "backups",
    "local-function",
  );
  await fs.mkdir(backupDirectory, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");
  const backupPath = path.join(
    backupDirectory,
    `${stamp}-${path.basename(sourcePath)}.bak`,
  );

  await fs.writeFile(backupPath, originalSource, {
    encoding: "utf8",
    flag: "wx",
  });

  const temporaryPath = path.join(
    path.dirname(sourcePath),
    `.once-local-${process.pid}-${Date.now()}-${path.basename(sourcePath)}.tmp`,
  );

  let replaced = false;

  try {
    await fs.writeFile(temporaryPath, patch.proposedSource, {
      encoding: "utf8",
      flag: "wx",
    });

    await fs.rename(temporaryPath, sourcePath);
    replaced = true;

    const applied = await fs.readFile(sourcePath, "utf8");
    if (sha256(applied) !== patch.proposedSourceSha256) {
      throw new Error(
        "Applied local-function source fingerprint differs from the reviewed plan.",
      );
    }

    await verifyJavaScriptSource(applied, sourcePath);

    return {
      file: plan.target.file,
      functionName: plan.target.function_name,
      backupPath,
      sourceSha256: patch.sourceSha256,
      appliedSha256: patch.proposedSourceSha256,
    };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });

    if (replaced) {
      await fs.writeFile(sourcePath, originalSource, "utf8");
    }

    throw error;
  }
}

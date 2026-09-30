import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const REVIEWED_LOCAL_SEMANTICS_FILE =
  "reviewed-local-semantics.json" as const;

export type ReviewedLocalSemanticsSelection = Readonly<{
  target: string;
  idPrefix: string;
  idPath: string;
  payloadPaths: readonly string[];
  confirmReviewed: boolean;
}>;

type CandidateEvidence = Readonly<{
  confidence: string;
  category: string;
  automation_status: string;
  auto_apply_eligible: false;
}>;

type SourceObservation = Readonly<{
  parameter_shape: "identifier" | "object_destructure";
  top_level_fields: readonly string[];
}>;

export type ReviewedLocalSemanticsPlan = Readonly<{
  schema_version: 1;
  kind: "reviewed_local_semantics_v1";
  generated_at: string;
  project: string;
  source_modified: false;
  runnable: false;
  target: Readonly<{
    file: string;
    function_name: string;
    source_sha256: string;
    candidate: CandidateEvidence;
    source_observations: SourceObservation;
  }>;
  review: Readonly<{
    developer_confirmed: true;
    identity: Readonly<{
      prefix: string;
      path: string;
    }>;
    payload: Readonly<{
      paths: readonly string[];
    }>;
  }>;
}>;

type ParsedTarget = Readonly<{
  file: string;
  functionName: string;
  sourcePath: string;
}>;

type ProtectPlanCandidate = Readonly<{
  file?: unknown;
  function_name?: unknown;
  confidence?: unknown;
  category?: unknown;
  automation_status?: unknown;
  auto_apply_eligible?: unknown;
}>;

const ALLOWED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);

const REVIEW_PATH = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

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
      "Reviewed local target must be a project-relative source file inside the selected project.",
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
      "Reviewed local target must be a regular non-symlink source file.",
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
      "Reviewed local target must be explicit file:function, for example orders.mjs:createOrder.",
    );
  }

  const fileValue = value.slice(0, separator).trim();
  const functionName = value.slice(separator + 1).trim();

  if (!fileValue || path.isAbsolute(fileValue)) {
    throw new Error(
      "Reviewed local target file must be project-relative, not absolute.",
    );
  }

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(functionName)) {
    throw new Error(
      "Reviewed local target function must be one simple identifier.",
    );
  }

  if (!ALLOWED_EXTENSIONS.has(path.extname(fileValue).toLowerCase())) {
    throw new Error(
      "Reviewed local target must be a JavaScript or TypeScript source file.",
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

function normalizeReviewPath(value: string, label: string): string {
  const normalized = value.trim();
  if (!REVIEW_PATH.test(normalized)) {
    throw new Error(
      `${label} must be a simple dot-separated property path relative to the function input object.`,
    );
  }
  return normalized;
}

function normalizeIdPrefix(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    /[\u0000-\u001F\u007F\s]/.test(normalized)
  ) {
    throw new Error(
      "Reviewed local identity prefix must be 1-128 non-whitespace characters.",
    );
  }
  return normalized;
}

function normalizeSelection(selection: ReviewedLocalSemanticsSelection): {
  idPrefix: string;
  idPath: string;
  payloadPaths: string[];
} {
  if (selection.confirmReviewed !== true) {
    throw new Error(
      "Reviewed local semantics require explicit developer confirmation. No review artifact was written.",
    );
  }

  const idPrefix = normalizeIdPrefix(selection.idPrefix);
  const idPath = normalizeReviewPath(selection.idPath, "Identity path");
  if (!Array.isArray(selection.payloadPaths) || selection.payloadPaths.length === 0) {
    throw new Error(
      "Reviewed local payload must explicitly list every effect-bearing input path.",
    );
  }

  const payloadPaths = selection.payloadPaths.map((item, index) =>
    normalizeReviewPath(item, `Payload path ${index + 1}`),
  );
  if (new Set(payloadPaths).size !== payloadPaths.length) {
    throw new Error("Reviewed local payload paths must be unique.");
  }
  if (!payloadPaths.includes(idPath)) {
    throw new Error(
      "Reviewed local payload paths must include the selected identity path so identity is effect-bound.",
    );
  }

  return { idPrefix, idPath, payloadPaths };
}

async function readCandidateEvidence(
  root: string,
  file: string,
  functionName: string,
): Promise<CandidateEvidence> {
  const protectPlanPath = path.join(root, ".once", "protect-plan.json");
  let parsed: { candidates?: unknown };
  try {
    parsed = JSON.parse(
      (await fs.readFile(protectPlanPath, "utf8")).replace(/^\uFEFF/, ""),
    ) as { candidates?: unknown };
  } catch {
    throw new Error(
      "Reviewed local semantics require the existing .once/protect-plan.json evidence. Run the public discovery/protection planning flow first.",
    );
  }

  if (!Array.isArray(parsed.candidates)) {
    throw new Error(
      "Existing .once/protect-plan.json does not contain a valid candidate list.",
    );
  }

  const matches = (parsed.candidates as ProtectPlanCandidate[]).filter(candidate =>
    candidate.auto_apply_eligible === false &&
    typeof candidate.file === "string" &&
    candidate.file.replaceAll("\\", "/") === file &&
    candidate.function_name === functionName
  );

  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "No matching non-auto-applicable candidate exists in .once/protect-plan.json for this target."
        : "More than one matching candidate exists in .once/protect-plan.json. Refusing ambiguous reviewed semantics.",
    );
  }

  const candidate = matches[0]!;
  if (
    typeof candidate.confidence !== "string" ||
    typeof candidate.category !== "string" ||
    typeof candidate.automation_status !== "string"
  ) {
    throw new Error(
      "Matching protect-plan candidate is missing required classification evidence.",
    );
  }

  return {
    confidence: candidate.confidence,
    category: candidate.category,
    automation_status: candidate.automation_status,
    auto_apply_eligible: false,
  };
}

async function inspectSourceFunction(
  source: string,
  fileName: string,
  functionName: string,
): Promise<SourceObservation> {
  const ts = await import("typescript");
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );

  const hasModifier = (node: import("typescript").Node, kind: import("typescript").SyntaxKind): boolean =>
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
      modifier => modifier.kind === kind,
    ) ?? false;

  const parameters: import("typescript").NodeArray<import("typescript").ParameterDeclaration>[] = [];

  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(statement, ts.SyntaxKind.AsyncKeyword)
    ) {
      parameters.push(statement.parameters);
      continue;
    }

    if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== functionName) continue;
      const initializer = declaration.initializer;
      if (
        initializer &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
        hasModifier(initializer, ts.SyntaxKind.AsyncKeyword)
      ) {
        parameters.push(initializer.parameters);
      }
    }
  }

  if (parameters.length !== 1) {
    throw new Error(
      parameters.length === 0
        ? "Reviewed local target must resolve to one top-level exported async function."
        : "Reviewed local target resolved to more than one exported async function. Refusing ambiguity.",
    );
  }

  const functionParameters = parameters[0]!;
  if (functionParameters.length !== 1) {
    throw new Error(
      "Reviewed local semantics v1 requires exactly one function input parameter.",
    );
  }

  const parameter = functionParameters[0]!;
  if (parameter.dotDotDotToken || parameter.questionToken || parameter.initializer) {
    throw new Error(
      "Reviewed local semantics v1 does not accept rest, optional, or defaulted function parameters.",
    );
  }

  if (ts.isIdentifier(parameter.name)) {
    return {
      parameter_shape: "identifier",
      top_level_fields: [],
    };
  }

  if (!ts.isObjectBindingPattern(parameter.name)) {
    throw new Error(
      "Reviewed local semantics v1 requires either one identifier input or one simple object-destructured input.",
    );
  }

  const fields: string[] = [];
  for (const element of parameter.name.elements) {
    if (
      element.dotDotDotToken ||
      element.propertyName ||
      element.initializer ||
      !ts.isIdentifier(element.name)
    ) {
      throw new Error(
        "Reviewed local semantics v1 only observes simple top-level object destructuring without aliases, defaults, or rest elements.",
      );
    }
    fields.push(element.name.text);
  }

  return {
    parameter_shape: "object_destructure",
    top_level_fields: fields,
  };
}

function sameCandidate(a: CandidateEvidence, b: CandidateEvidence): boolean {
  return (
    a.confidence === b.confidence &&
    a.category === b.category &&
    a.automation_status === b.automation_status &&
    a.auto_apply_eligible === b.auto_apply_eligible
  );
}

function sameObservation(a: SourceObservation, b: SourceObservation): boolean {
  return (
    a.parameter_shape === b.parameter_shape &&
    JSON.stringify(a.top_level_fields) === JSON.stringify(b.top_level_fields)
  );
}

async function buildReviewedPlan(
  requestedPath: string,
  selection: ReviewedLocalSemanticsSelection,
): Promise<ReviewedLocalSemanticsPlan> {
  const root = path.resolve(requestedPath);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error("Reviewed local project target must be a directory.");
  }

  const reviewed = normalizeSelection(selection);
  const parsed = parseTarget(root, selection.target);
  await assertRegularContainedFile(root, parsed.sourcePath);
  const source = await fs.readFile(parsed.sourcePath, "utf8");
  const [candidate, sourceObservations] = await Promise.all([
    readCandidateEvidence(root, parsed.file, parsed.functionName),
    inspectSourceFunction(source, parsed.file, parsed.functionName),
  ]);

  return {
    schema_version: 1,
    kind: "reviewed_local_semantics_v1",
    generated_at: new Date().toISOString(),
    project: root,
    source_modified: false,
    runnable: false,
    target: {
      file: parsed.file,
      function_name: parsed.functionName,
      source_sha256: sha256(source),
      candidate,
      source_observations: sourceObservations,
    },
    review: {
      developer_confirmed: true,
      identity: {
        prefix: reviewed.idPrefix,
        path: reviewed.idPath,
      },
      payload: {
        paths: reviewed.payloadPaths,
      },
    },
  };
}

function isReviewedPlan(value: unknown): value is ReviewedLocalSemanticsPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Partial<ReviewedLocalSemanticsPlan>;
  const target = plan.target as Partial<ReviewedLocalSemanticsPlan["target"]> | undefined;
  const candidate = target?.candidate as Partial<CandidateEvidence> | undefined;
  const observations = target?.source_observations as Partial<SourceObservation> | undefined;
  const review = plan.review as Partial<ReviewedLocalSemanticsPlan["review"]> | undefined;
  const identity = review?.identity as Partial<ReviewedLocalSemanticsPlan["review"]["identity"]> | undefined;
  const payload = review?.payload as Partial<ReviewedLocalSemanticsPlan["review"]["payload"]> | undefined;

  return (
    plan.schema_version === 1 &&
    plan.kind === "reviewed_local_semantics_v1" &&
    typeof plan.generated_at === "string" &&
    typeof plan.project === "string" &&
    plan.source_modified === false &&
    plan.runnable === false &&
    target !== undefined &&
    typeof target.file === "string" &&
    typeof target.function_name === "string" &&
    typeof target.source_sha256 === "string" &&
    candidate !== undefined &&
    typeof candidate.confidence === "string" &&
    typeof candidate.category === "string" &&
    typeof candidate.automation_status === "string" &&
    candidate.auto_apply_eligible === false &&
    observations !== undefined &&
    (observations.parameter_shape === "identifier" || observations.parameter_shape === "object_destructure") &&
    Array.isArray(observations.top_level_fields) &&
    observations.top_level_fields.every(item => typeof item === "string") &&
    review?.developer_confirmed === true &&
    identity !== undefined &&
    typeof identity.prefix === "string" &&
    typeof identity.path === "string" &&
    payload !== undefined &&
    Array.isArray(payload.paths) &&
    payload.paths.every(item => typeof item === "string")
  );
}

export async function planReviewedLocalSemantics(
  requestedPath: string,
  selection: ReviewedLocalSemanticsSelection,
): Promise<ReviewedLocalSemanticsPlan> {
  return buildReviewedPlan(requestedPath, selection);
}

export async function writeReviewedLocalSemanticsPlan(
  requestedPath: string,
  selection: ReviewedLocalSemanticsSelection,
): Promise<ReviewedLocalSemanticsPlan> {
  const root = path.resolve(requestedPath);
  const plan = await buildReviewedPlan(root, selection);
  const onceDirectory = path.join(root, ".once");
  await fs.mkdir(onceDirectory, { recursive: true });
  await fs.writeFile(
    path.join(onceDirectory, REVIEWED_LOCAL_SEMANTICS_FILE),
    JSON.stringify(plan, null, 2) + "\n",
    { encoding: "utf8", flag: "wx" },
  );
  return plan;
}

export async function validateReviewedLocalSemanticsPlan(
  requestedPath: string,
): Promise<ReviewedLocalSemanticsPlan> {
  const root = path.resolve(requestedPath);
  const planPath = path.join(root, ".once", REVIEWED_LOCAL_SEMANTICS_FILE);
  const raw = await fs.readFile(planPath, "utf8");
  const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!isReviewedPlan(parsed)) {
    throw new Error("Reviewed local semantics artifact is malformed or outside v1.");
  }

  const plan = parsed;
  if (path.resolve(plan.project) !== root) {
    throw new Error(
      "Reviewed local semantics project no longer matches the selected project.",
    );
  }

  const normalized = normalizeSelection({
    target: `${plan.target.file}:${plan.target.function_name}`,
    idPrefix: plan.review.identity.prefix,
    idPath: plan.review.identity.path,
    payloadPaths: plan.review.payload.paths,
    confirmReviewed: plan.review.developer_confirmed,
  });

  const target = parseTarget(root, `${plan.target.file}:${plan.target.function_name}`);
  await assertRegularContainedFile(root, target.sourcePath);
  const source = await fs.readFile(target.sourcePath, "utf8");
  if (sha256(source) !== plan.target.source_sha256) {
    throw new Error(
      "Source changed after reviewed local semantics were recorded. Refusing stale review.",
    );
  }

  const [candidate, observations] = await Promise.all([
    readCandidateEvidence(root, plan.target.file, plan.target.function_name),
    inspectSourceFunction(source, plan.target.file, plan.target.function_name),
  ]);

  if (!sameCandidate(candidate, plan.target.candidate)) {
    throw new Error(
      "Protect-plan candidate evidence changed after semantic review. Refusing stale review.",
    );
  }
  if (!sameObservation(observations, plan.target.source_observations)) {
    throw new Error(
      "Source observations changed after semantic review. Refusing stale review.",
    );
  }
  if (
    normalized.idPrefix !== plan.review.identity.prefix ||
    normalized.idPath !== plan.review.identity.path ||
    JSON.stringify(normalized.payloadPaths) !== JSON.stringify(plan.review.payload.paths)
  ) {
    throw new Error(
      "Reviewed semantic choices are not canonical. Refusing ambiguous review artifact.",
    );
  }

  return plan;
}

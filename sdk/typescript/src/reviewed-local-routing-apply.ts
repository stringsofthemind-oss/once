import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildReviewedLocalRoutingPreview,
  type ReviewedLocalRoutingRoute,
} from "./reviewed-local-routing-preview.js";
import {
  loadReviewedLocalRoutingReview,
} from "./reviewed-local-routing-review.js";

export type ReviewedLocalRoutingApplyResult = Readonly<{
  schema_version: 1;
  kind: "reviewed_local_routing_apply_v1";
  file: string;
  function_name: string;
  routing_review_fingerprint: string;
  backup_path: string;
  source_sha256: string;
  applied_sha256: string;
  source_modified: true;
  generated_file_modified: false;
  application_wired: true;
}>;

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

async function assertRegularContainedFile(
  root: string,
  filePath: string,
  label: string,
): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }

  const [realRoot, realFile] = await Promise.all([
    fs.realpath(root),
    fs.realpath(filePath),
  ]);
  assertContained(realRoot, realFile, label);
}

async function verifySourceParses(source: string, fileName: string): Promise<void> {
  const ts = await import("typescript");
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
    },
  });

  const errors = (result.diagnostics ?? []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      "Reviewed caller routing result does not parse successfully:\n" +
        errors
          .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
          .join("\n"),
    );
  }
}

function sameEvidence(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildAppliedSource(
  source: string,
  route: ReviewedLocalRoutingRoute,
): string {
  const replacement = route.replacement;
  if (
    replacement.start < 0 ||
    replacement.end <= replacement.start ||
    replacement.end > source.length
  ) {
    throw new Error(
      "Reviewed routing replacement range is outside the current caller source. Refusing source mutation.",
    );
  }

  const current = source.slice(replacement.start, replacement.end);
  if (
    current !== replacement.before ||
    sha256(current) !== replacement.before_sha256
  ) {
    throw new Error(
      "Reviewed routing replacement bytes no longer match the current caller source. Refusing stale routing apply.",
    );
  }

  if (sha256(replacement.after) !== replacement.after_sha256) {
    throw new Error(
      "Reviewed routing replacement output fingerprint is invalid. Refusing source mutation.",
    );
  }

  return (
    source.slice(0, replacement.start) +
    replacement.after +
    source.slice(replacement.end)
  );
}

async function atomicReplace(
  sourcePath: string,
  nextSource: string,
): Promise<string> {
  const temporaryPath = path.join(
    path.dirname(sourcePath),
    `.once-routing-${process.pid}-${Date.now()}-${path.basename(sourcePath)}.tmp`,
  );

  await fs.writeFile(temporaryPath, nextSource, {
    encoding: "utf8",
    flag: "wx",
  });

  try {
    await fs.rename(temporaryPath, sourcePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }

  return temporaryPath;
}

async function rollbackAtomic(
  sourcePath: string,
  originalSource: string,
): Promise<void> {
  const rollbackPath = path.join(
    path.dirname(sourcePath),
    `.once-routing-rollback-${process.pid}-${Date.now()}-${path.basename(sourcePath)}.tmp`,
  );
  await fs.writeFile(rollbackPath, originalSource, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await fs.rename(rollbackPath, sourcePath);
  } catch (error) {
    await fs.rm(rollbackPath, { force: true });
    throw error;
  }
}

export async function applyReviewedLocalRouting(
  requestedPath: string,
): Promise<ReviewedLocalRoutingApplyResult> {
  const root = path.resolve(requestedPath);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error("Reviewed routing apply project target must be a directory.");
  }

  const review = await loadReviewedLocalRoutingReview(root);

  if (review.review.routes.length !== 1) {
    throw new Error(
      "Reviewed routing apply v1 requires exactly one caller module. Multi-file routing cannot be claimed transactional without a durable recovery protocol, so no source was modified.",
    );
  }

  const preview = await buildReviewedLocalRoutingPreview(root);
  if (preview.status !== "PATCHABLE_PREVIEW" || preview.routes.length !== 1) {
    throw new Error(
      "Current routing evidence is no longer exactly one PATCHABLE_PREVIEW route. Refusing stale reviewed routing apply.",
    );
  }

  if (
    preview.inventory_fingerprint !== review.review.inventory_fingerprint ||
    !sameEvidence(preview.target, review.review.target) ||
    !sameEvidence(preview.companion, review.review.companion) ||
    !sameEvidence(preview.routes, review.review.routes)
  ) {
    throw new Error(
      "Current routing preview differs from the developer-reviewed routing evidence. Refusing stale source mutation.",
    );
  }

  const route = review.review.routes[0]!;
  const sourcePath = path.resolve(root, route.file);
  assertContained(root, sourcePath, "Reviewed routing caller source");
  await assertRegularContainedFile(root, sourcePath, "Reviewed routing caller source");

  const originalSource = await fs.readFile(sourcePath, "utf8");
  if (sha256(originalSource) !== route.source_sha256) {
    throw new Error(
      "Caller source changed after routing review. Refusing stale reviewed routing apply.",
    );
  }

  const nextSource = buildAppliedSource(originalSource, route);
  if (sha256(nextSource) !== route.result_source_sha256) {
    throw new Error(
      "Recomputed caller routing result differs from the reviewed preview. Refusing source mutation.",
    );
  }
  await verifySourceParses(nextSource, sourcePath);

  const onceDirectory = path.join(root, ".once");
  const backupDirectory = path.join(onceDirectory, "backups", "reviewed-routing");
  await fs.mkdir(backupDirectory, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    backupDirectory,
    `${stamp}-${path.basename(sourcePath)}.bak`,
  );
  await fs.writeFile(backupPath, originalSource, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  let replaced = false;
  try {
    await atomicReplace(sourcePath, nextSource);
    replaced = true;

    const applied = await fs.readFile(sourcePath, "utf8");
    if (sha256(applied) !== route.result_source_sha256) {
      throw new Error(
        "Applied caller routing fingerprint differs from the reviewed preview.",
      );
    }
    await verifySourceParses(applied, sourcePath);

    return {
      schema_version: 1,
      kind: "reviewed_local_routing_apply_v1",
      file: route.file,
      function_name: review.review.target.function_name,
      routing_review_fingerprint: review.review.routing_review_fingerprint,
      backup_path: backupPath,
      source_sha256: route.source_sha256,
      applied_sha256: route.result_source_sha256,
      source_modified: true,
      generated_file_modified: false,
      application_wired: true,
    };
  } catch (error) {
    if (replaced) {
      try {
        await rollbackAtomic(sourcePath, originalSource);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Reviewed routing apply failed and atomic rollback also failed. Manual recovery from the exact backup is required.",
        );
      }
    }
    throw error;
  }
}

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

export const REVIEWED_LOCAL_ROUTING_APPLY_FILE =
  "reviewed-local-routing-apply.json" as const;
export const REVIEWED_LOCAL_ROUTING_TRANSACTION_FILE =
  "reviewed-local-routing-transaction.json" as const;

export type ReviewedLocalRoutingApplyReceipt = Readonly<{
  schema_version: 1;
  kind: "reviewed_local_routing_apply_v1";
  applied_at: string;
  project: string;
  routing_review_fingerprint: string;
  inventory_fingerprint: string;
  source_modified: true;
  generated_file_modified: false;
  application_wired: true;
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
  files: readonly Readonly<{
    file: string;
    backup_file: string;
    source_sha256: string;
    applied_sha256: string;
  }>[];
}>;

type PreparedFile = Readonly<{
  file: string;
  sourcePath: string;
  originalSource: string;
  proposedSource: string;
  sourceSha256: string;
  appliedSha256: string;
  backupPath: string;
  backupFile: string;
  temporaryPath: string;
  mode: number;
}>;

function sha256(value: string): string {
  return createHash("sha256")
    .update(value.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

function assertSupportedLocalRuntime(): void {
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error(
      "Reviewed local routing apply requires Node.js 24.15 or later because the active companion uses durable local SQLite protection. Application source was not modified.",
    );
  }
}

function assertContained(realRoot: string, candidate: string, label: string): void {
  const relative = path.relative(realRoot, candidate);
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
  realRoot: string,
  relativeFile: string,
  label: string,
): Promise<{ sourcePath: string; mode: number }> {
  if (!relativeFile || path.isAbsolute(relativeFile)) {
    throw new Error(`${label} must be a project-relative file.`);
  }
  const sourcePath = path.resolve(root, relativeFile);
  assertContained(root, sourcePath, label);

  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  const realSource = await fs.realpath(sourcePath);
  assertContained(realRoot, realSource, label);
  return { sourcePath, mode: stat.mode & 0o777 };
}

async function ensureSafeDirectory(
  realRoot: string,
  directory: string,
  label: string,
  create: boolean,
): Promise<void> {
  if (create) {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory.`);
  }
  const realDirectory = await fs.realpath(directory);
  assertContained(realRoot, realDirectory, label);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function verifySourceParses(source: string, fileName: string): Promise<void> {
  const ts = await import("typescript");
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
    },
  });
  const errors = (result.diagnostics ?? []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const message = errors
      .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
      .join("\n");
    throw new Error(
      `Reviewed routing result for ${fileName} does not parse successfully:\n${message}`,
    );
  }
}

function exactReviewMatch(
  preview: Awaited<ReturnType<typeof buildReviewedLocalRoutingPreview>>,
  review: Awaited<ReturnType<typeof loadReviewedLocalRoutingReview>>,
): boolean {
  return (
    preview.status === "PATCHABLE_PREVIEW" &&
    preview.routes.length > 0 &&
    preview.inventory_fingerprint === review.review.inventory_fingerprint &&
    JSON.stringify(preview.target) === JSON.stringify(review.review.target) &&
    JSON.stringify(preview.companion) === JSON.stringify(review.review.companion) &&
    JSON.stringify(preview.routes) === JSON.stringify(review.review.routes)
  );
}

function applyReviewedReplacement(
  source: string,
  route: ReviewedLocalRoutingRoute,
): string {
  const { start, end, before, after, before_sha256, after_sha256 } = route.replacement;
  if (
    start < 0 ||
    end <= start ||
    end > source.length ||
    source.slice(start, end) !== before ||
    sha256(before) !== before_sha256 ||
    sha256(after) !== after_sha256
  ) {
    throw new Error(
      `Reviewed routing replacement evidence no longer matches ${route.file}. Refusing source mutation.`,
    );
  }
  const proposed = source.slice(0, start) + after + source.slice(end);
  if (sha256(proposed) !== route.result_source_sha256) {
    throw new Error(
      `Recomputed routing result for ${route.file} differs from the developer-reviewed preview. Refusing source mutation.`,
    );
  }
  return proposed;
}

function safeBackupBasename(file: string, index: number): string {
  const base = path.basename(file).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100) || "source";
  return `${String(index + 1).padStart(3, "0")}-${sha256(file).slice(0, 12)}-${base}.bak`;
}

async function rollbackAppliedFiles(
  applied: readonly PreparedFile[],
  token: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const item of [...applied].reverse()) {
    const rollbackTemp = path.join(
      path.dirname(item.sourcePath),
      `.once-routing-rollback-${token}-${path.basename(item.sourcePath)}.tmp`,
    );
    try {
      await fs.writeFile(rollbackTemp, item.originalSource, {
        encoding: "utf8",
        flag: "wx",
        mode: item.mode,
      });
      await fs.chmod(rollbackTemp, item.mode);
      await fs.rename(rollbackTemp, item.sourcePath);
      const restored = await fs.readFile(item.sourcePath, "utf8");
      if (restored !== item.originalSource || sha256(restored) !== item.sourceSha256) {
        throw new Error("restored fingerprint mismatch");
      }
    } catch (error) {
      await fs.rm(rollbackTemp, { force: true }).catch(() => undefined);
      failures.push(
        `${item.file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failures;
}

export async function applyReviewedLocalRouting(
  requestedPath: string,
  confirmApply: boolean,
): Promise<ReviewedLocalRoutingApplyReceipt> {
  if (confirmApply !== true) {
    throw new Error(
      "Reviewed local routing apply requires explicit confirmation after developer routing review. Application source was not modified.",
    );
  }
  assertSupportedLocalRuntime();

  const root = path.resolve(requestedPath);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Reviewed routing apply project target must be a regular non-symlink directory.");
  }
  const realRoot = await fs.realpath(root);
  const onceDirectory = path.join(root, ".once");
  await ensureSafeDirectory(realRoot, onceDirectory, "Once state directory", false);

  const receiptPath = path.join(onceDirectory, REVIEWED_LOCAL_ROUTING_APPLY_FILE);
  const transactionPath = path.join(
    onceDirectory,
    REVIEWED_LOCAL_ROUTING_TRANSACTION_FILE,
  );
  const lockPath = path.join(onceDirectory, "reviewed-local-routing-apply.lock");

  if (await pathExists(receiptPath)) {
    throw new Error(
      "Reviewed local routing has already been applied for this project. Refusing a second routing mutation.",
    );
  }
  if (await pathExists(transactionPath)) {
    throw new Error(
      "An unfinished reviewed routing transaction record already exists. Refusing further mutation until the prior transaction is deliberately inspected and recovered.",
    );
  }

  try {
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Another reviewed routing apply appears to be in progress. Refusing concurrent source mutation.",
      );
    }
    throw error;
  }

  const token = `${process.pid}-${Date.now()}`;
  const prepared: PreparedFile[] = [];
  const applied: PreparedFile[] = [];
  let transactionWritten = false;
  let receiptWritten = false;

  try {
    const review = await loadReviewedLocalRoutingReview(root);
    const preview = await buildReviewedLocalRoutingPreview(root);
    if (!exactReviewMatch(preview, review)) {
      throw new Error(
        "Current routing evidence differs from the developer-reviewed routing artifact. Refusing stale or drifted source mutation.",
      );
    }

    const routeFiles = new Set<string>();
    for (const route of review.review.routes) {
      if (routeFiles.has(route.file)) {
        throw new Error(
          "Reviewed routing apply v1 requires at most one reviewed import replacement per caller file. Refusing ambiguous multi-replacement mutation.",
        );
      }
      routeFiles.add(route.file);
    }

    const backupsDirectory = path.join(onceDirectory, "backups");
    await ensureSafeDirectory(realRoot, backupsDirectory, "Once backup directory", true);
    const routingBackupsDirectory = path.join(backupsDirectory, "reviewed-routing");
    await ensureSafeDirectory(
      realRoot,
      routingBackupsDirectory,
      "Reviewed routing backup directory",
      true,
    );
    const transactionDirectory = path.join(
      routingBackupsDirectory,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${review.review.routing_review_fingerprint.slice(0, 12)}-${process.pid}`,
    );
    await ensureSafeDirectory(
      realRoot,
      transactionDirectory,
      "Reviewed routing transaction backup directory",
      true,
    );

    for (const [index, route] of review.review.routes.entries()) {
      const checked = await assertRegularContainedFile(
        root,
        realRoot,
        route.file,
        "Reviewed routing caller source",
      );
      const originalSource = await fs.readFile(checked.sourcePath, "utf8");
      if (sha256(originalSource) !== route.source_sha256) {
        throw new Error(
          `Caller source ${route.file} changed after routing review. Refusing stale mutation.`,
        );
      }
      const proposedSource = applyReviewedReplacement(originalSource, route);
      await verifySourceParses(proposedSource, checked.sourcePath);

      const backupPath = path.join(
        transactionDirectory,
        safeBackupBasename(route.file, index),
      );
      const temporaryPath = path.join(
        path.dirname(checked.sourcePath),
        `.once-routing-${token}-${index}-${path.basename(checked.sourcePath)}.tmp`,
      );
      prepared.push({
        file: route.file,
        sourcePath: checked.sourcePath,
        originalSource,
        proposedSource,
        sourceSha256: route.source_sha256,
        appliedSha256: route.result_source_sha256,
        backupPath,
        backupFile: path.relative(root, backupPath).replaceAll("\\", "/"),
        temporaryPath,
        mode: checked.mode,
      });
    }

    for (const item of prepared) {
      await fs.writeFile(item.backupPath, item.originalSource, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.writeFile(item.temporaryPath, item.proposedSource, {
        encoding: "utf8",
        flag: "wx",
        mode: item.mode,
      });
      await fs.chmod(item.temporaryPath, item.mode);
    }

    for (const item of prepared) {
      const current = await fs.readFile(item.sourcePath, "utf8");
      if (current !== item.originalSource || sha256(current) !== item.sourceSha256) {
        throw new Error(
          `Caller source ${item.file} changed during routing apply preparation. Refusing any application mutation.`,
        );
      }
    }

    const transaction = {
      schema_version: 1,
      kind: "reviewed_local_routing_transaction_v1",
      state: "PREPARED",
      prepared_at: new Date().toISOString(),
      project: root,
      routing_review_fingerprint: review.review.routing_review_fingerprint,
      files: prepared.map(item => ({
        file: item.file,
        backup_file: item.backupFile,
        source_sha256: item.sourceSha256,
        applied_sha256: item.appliedSha256,
      })),
    };
    await fs.writeFile(
      transactionPath,
      `${JSON.stringify(transaction, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    transactionWritten = true;

    for (const item of prepared) {
      const current = await fs.readFile(item.sourcePath, "utf8");
      if (current !== item.originalSource || sha256(current) !== item.sourceSha256) {
        throw new Error(
          `Caller source ${item.file} changed immediately before commit. Refusing partial routing mutation.`,
        );
      }
      await fs.rename(item.temporaryPath, item.sourcePath);
      applied.push(item);
      const written = await fs.readFile(item.sourcePath, "utf8");
      if (written !== item.proposedSource || sha256(written) !== item.appliedSha256) {
        throw new Error(
          `Applied routing source fingerprint differs from the reviewed result for ${item.file}.`,
        );
      }
    }

    const receipt: ReviewedLocalRoutingApplyReceipt = {
      schema_version: 1,
      kind: "reviewed_local_routing_apply_v1",
      applied_at: new Date().toISOString(),
      project: root,
      routing_review_fingerprint: review.review.routing_review_fingerprint,
      inventory_fingerprint: review.review.inventory_fingerprint,
      source_modified: true,
      generated_file_modified: false,
      application_wired: true,
      target: review.review.target,
      companion: review.review.companion,
      files: prepared.map(item => ({
        file: item.file,
        backup_file: item.backupFile,
        source_sha256: item.sourceSha256,
        applied_sha256: item.appliedSha256,
      })),
    };

    await fs.writeFile(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    receiptWritten = true;
    await fs.rm(transactionPath, { force: true });
    transactionWritten = false;

    return receipt;
  } catch (error) {
    for (const item of prepared) {
      await fs.rm(item.temporaryPath, { force: true }).catch(() => undefined);
    }

    const rollbackFailures = await rollbackAppliedFiles(applied, token);
    if (receiptWritten) {
      await fs.rm(receiptPath, { force: true }).catch(() => undefined);
      receiptWritten = false;
    }
    if (rollbackFailures.length === 0 && transactionWritten) {
      await fs.rm(transactionPath, { force: true }).catch(() => undefined);
      transactionWritten = false;
    }

    if (rollbackFailures.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          "Reviewed routing apply could not fully roll back. The transaction record and backups were retained; inspect them before any further mutation.\n" +
          rollbackFailures.join("\n"),
      );
    }
    throw error;
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

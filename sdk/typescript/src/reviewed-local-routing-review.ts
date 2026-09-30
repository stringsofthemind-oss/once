import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildReviewedLocalRoutingPreview,
  type ReviewedLocalRoutingPreview,
  type ReviewedLocalRoutingRoute,
} from "./reviewed-local-routing-preview.js";

export const REVIEWED_LOCAL_ROUTING_REVIEW_FILE =
  "reviewed-local-routing-review.json" as const;

export type ReviewedLocalRoutingReview = Readonly<{
  schema_version: 1;
  kind: "reviewed_local_routing_review_v1";
  generated_at: string;
  project: string;
  source_modified: false;
  generated_file_modified: false;
  application_wired: false;
  review: Readonly<{
    developer_confirmed: true;
    inventory_fingerprint: string;
    routing_review_fingerprint: string;
    target: ReviewedLocalRoutingPreview["target"];
    companion: ReviewedLocalRoutingPreview["companion"];
    routes: readonly ReviewedLocalRoutingRoute[];
  }>;
}>;

const SHA256 = /^[0-9a-f]{64}$/;

function sha256(value: string): string {
  return createHash("sha256")
    .update(value.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return JSON.stringify(actual) === JSON.stringify(wanted);
}

function reviewFingerprint(preview: ReviewedLocalRoutingPreview): string {
  return sha256(JSON.stringify({
    schema_version: 1,
    kind: "reviewed_local_routing_review_v1",
    inventory_fingerprint: preview.inventory_fingerprint,
    target: preview.target,
    companion: preview.companion,
    routes: preview.routes,
  }));
}

function isTarget(value: unknown): value is ReviewedLocalRoutingPreview["target"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    exactKeys(target, ["file", "function_name", "source_sha256", "review_fingerprint"]) &&
    typeof target.file === "string" &&
    typeof target.function_name === "string" &&
    typeof target.source_sha256 === "string" && SHA256.test(target.source_sha256) &&
    typeof target.review_fingerprint === "string" && SHA256.test(target.review_fingerprint)
  );
}

function isCompanion(value: unknown): value is ReviewedLocalRoutingPreview["companion"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const companion = value as Record<string, unknown>;
  return (
    exactKeys(companion, ["file", "module_sha256", "verified_materialized"]) &&
    typeof companion.file === "string" &&
    typeof companion.module_sha256 === "string" && SHA256.test(companion.module_sha256) &&
    companion.verified_materialized === true
  );
}

function isReplacement(value: unknown): value is ReviewedLocalRoutingRoute["replacement"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const replacement = value as Record<string, unknown>;
  return (
    exactKeys(replacement, [
      "start",
      "end",
      "line",
      "column",
      "before",
      "after",
      "before_sha256",
      "after_sha256",
    ]) &&
    Number.isInteger(replacement.start) && Number(replacement.start) >= 0 &&
    Number.isInteger(replacement.end) && Number(replacement.end) > Number(replacement.start) &&
    Number.isInteger(replacement.line) && Number(replacement.line) >= 1 &&
    Number.isInteger(replacement.column) && Number(replacement.column) >= 1 &&
    typeof replacement.before === "string" && replacement.before.length > 0 &&
    typeof replacement.after === "string" && replacement.after.length > 0 &&
    typeof replacement.before_sha256 === "string" && SHA256.test(replacement.before_sha256) &&
    typeof replacement.after_sha256 === "string" && SHA256.test(replacement.after_sha256) &&
    sha256(replacement.before) === replacement.before_sha256 &&
    sha256(replacement.after) === replacement.after_sha256
  );
}

function isRoute(value: unknown): value is ReviewedLocalRoutingRoute {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  return (
    exactKeys(route, [
      "file",
      "source_sha256",
      "result_source_sha256",
      "imported_name",
      "local_name",
      "direct_call_count",
      "import_line",
      "replacement",
    ]) &&
    typeof route.file === "string" && route.file.length > 0 &&
    typeof route.source_sha256 === "string" && SHA256.test(route.source_sha256) &&
    typeof route.result_source_sha256 === "string" && SHA256.test(route.result_source_sha256) &&
    typeof route.imported_name === "string" && route.imported_name.length > 0 &&
    typeof route.local_name === "string" && route.local_name.length > 0 &&
    Number.isInteger(route.direct_call_count) && Number(route.direct_call_count) >= 1 &&
    Number.isInteger(route.import_line) && Number(route.import_line) >= 1 &&
    isReplacement(route.replacement)
  );
}

function isReviewedRoutingReview(value: unknown): value is ReviewedLocalRoutingReview {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  if (!exactKeys(artifact, [
    "schema_version",
    "kind",
    "generated_at",
    "project",
    "source_modified",
    "generated_file_modified",
    "application_wired",
    "review",
  ])) return false;

  if (artifact.review === null || typeof artifact.review !== "object" || Array.isArray(artifact.review)) {
    return false;
  }
  const review = artifact.review as Record<string, unknown>;
  if (!exactKeys(review, [
    "developer_confirmed",
    "inventory_fingerprint",
    "routing_review_fingerprint",
    "target",
    "companion",
    "routes",
  ])) return false;

  return (
    artifact.schema_version === 1 &&
    artifact.kind === "reviewed_local_routing_review_v1" &&
    typeof artifact.generated_at === "string" && artifact.generated_at.length > 0 &&
    typeof artifact.project === "string" && artifact.project.length > 0 &&
    artifact.source_modified === false &&
    artifact.generated_file_modified === false &&
    artifact.application_wired === false &&
    review.developer_confirmed === true &&
    typeof review.inventory_fingerprint === "string" && SHA256.test(review.inventory_fingerprint) &&
    typeof review.routing_review_fingerprint === "string" && SHA256.test(review.routing_review_fingerprint) &&
    isTarget(review.target) &&
    isCompanion(review.companion) &&
    Array.isArray(review.routes) && review.routes.length > 0 && review.routes.every(isRoute)
  );
}

async function ensureReviewDirectory(root: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const oncePath = path.join(root, ".once");
  try {
    const stat = await fs.lstat(oncePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Reviewed routing state directory must be a regular non-symlink directory.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(oncePath, { mode: 0o700 });
  }

  const realOnce = await fs.realpath(oncePath);
  const relative = path.relative(realRoot, realOnce);
  if (relative !== ".once" || path.isAbsolute(relative)) {
    throw new Error("Reviewed routing state directory must remain inside the selected project.");
  }
  return oncePath;
}

export async function buildReviewedLocalRoutingReview(
  requestedPath: string,
  confirmReviewed: boolean,
): Promise<ReviewedLocalRoutingReview> {
  if (confirmReviewed !== true) {
    throw new Error(
      "Reviewed local routing requires explicit developer confirmation of the exact routing preview. No routing review artifact was written.",
    );
  }

  const root = path.resolve(requestedPath);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error("Reviewed routing project target must be a directory.");
  }

  const preview = await buildReviewedLocalRoutingPreview(root);
  if (preview.status === "BLOCKED") {
    throw new Error(
      "Reviewed local routing cannot be confirmed while the current routing preview is BLOCKED. Resolve ambiguity and preview again.",
    );
  }
  if (preview.status !== "PATCHABLE_PREVIEW" || preview.routes.length === 0) {
    throw new Error(
      "Reviewed local routing requires at least one exact PATCHABLE_PREVIEW route. No routing review artifact was written.",
    );
  }

  const fingerprint = reviewFingerprint(preview);
  return {
    schema_version: 1,
    kind: "reviewed_local_routing_review_v1",
    generated_at: new Date().toISOString(),
    project: root,
    source_modified: false,
    generated_file_modified: false,
    application_wired: false,
    review: {
      developer_confirmed: true,
      inventory_fingerprint: preview.inventory_fingerprint,
      routing_review_fingerprint: fingerprint,
      target: preview.target,
      companion: preview.companion,
      routes: preview.routes,
    },
  };
}

export async function writeReviewedLocalRoutingReview(
  requestedPath: string,
  confirmReviewed: boolean,
): Promise<ReviewedLocalRoutingReview> {
  const root = path.resolve(requestedPath);
  const artifact = await buildReviewedLocalRoutingReview(root, confirmReviewed);
  const oncePath = await ensureReviewDirectory(root);
  const artifactPath = path.join(oncePath, REVIEWED_LOCAL_ROUTING_REVIEW_FILE);

  try {
    await fs.writeFile(
      artifactPath,
      `${JSON.stringify(artifact, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Reviewed local routing artifact already exists. Refusing to overwrite developer-approved routing evidence.",
      );
    }
    throw error;
  }

  return artifact;
}

export async function loadReviewedLocalRoutingReview(
  requestedPath: string,
): Promise<ReviewedLocalRoutingReview> {
  const root = path.resolve(requestedPath);
  const artifactPath = path.join(root, ".once", REVIEWED_LOCAL_ROUTING_REVIEW_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse((await fs.readFile(artifactPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(
      "A valid .once/reviewed-local-routing-review.json artifact is required. Preview routing and confirm it explicitly first.",
    );
  }

  if (!isReviewedRoutingReview(parsed)) {
    throw new Error("Reviewed local routing review artifact is malformed or uses an unsupported schema.");
  }
  if (path.resolve(parsed.project) !== root) {
    throw new Error("Reviewed local routing review artifact belongs to a different project path.");
  }

  const expectedFingerprint = sha256(JSON.stringify({
    schema_version: 1,
    kind: "reviewed_local_routing_review_v1",
    inventory_fingerprint: parsed.review.inventory_fingerprint,
    target: parsed.review.target,
    companion: parsed.review.companion,
    routes: parsed.review.routes,
  }));
  if (expectedFingerprint !== parsed.review.routing_review_fingerprint) {
    throw new Error("Reviewed local routing review fingerprint does not match its bound evidence.");
  }

  return parsed;
}

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildReviewedLocalProtectionPreview,
} from "./reviewed-local-preview.js";

export type ReviewedLocalMaterializationResult = Readonly<{
  file: string;
  module_sha256: string;
  source_sha256: string;
  review_fingerprint: string;
  source_modified: false;
  application_wired: false;
}>;

function assertSupportedLocalRuntime(): void {
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error(
      "Reviewed local companion materialization requires Node.js 24.15 or later because the generated wrapper uses durable local SQLite protection. No generated file was written.",
    );
  }
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

async function assertSafeDirectory(
  realRoot: string,
  directory: string,
  label: string,
  create: boolean,
): Promise<void> {
  if (create) {
    try {
      await fs.mkdir(directory);
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

export async function materializeReviewedLocalCompanion(
  requestedPath: string,
): Promise<ReviewedLocalMaterializationResult> {
  assertSupportedLocalRuntime();

  const root = path.resolve(requestedPath);
  const realRoot = await fs.realpath(root);
  const preview = await buildReviewedLocalProtectionPreview(root);

  const onceDirectory = path.join(root, ".once");
  await assertSafeDirectory(realRoot, onceDirectory, "Once state directory", false);

  const generatedDirectory = path.join(onceDirectory, "generated");
  await assertSafeDirectory(
    realRoot,
    generatedDirectory,
    "Reviewed local generated directory",
    true,
  );

  const outputPath = path.resolve(root, preview.output.file);
  assertContained(realRoot, outputPath, "Reviewed local generated module");

  const expectedGeneratedRoot = path.resolve(generatedDirectory);
  const outputRelative = path.relative(expectedGeneratedRoot, outputPath);
  if (
    outputRelative === "" ||
    outputRelative.startsWith("..") ||
    path.isAbsolute(outputRelative)
  ) {
    throw new Error(
      "Reviewed local generated module must remain inside .once/generated.",
    );
  }

  if (await pathExists(outputPath)) {
    throw new Error(
      `Reviewed local generated module already exists at ${preview.output.file}. Refusing overwrite; remove it only after deliberate review if regeneration is required.`,
    );
  }

  let written = false;
  try {
    await fs.writeFile(outputPath, preview.output.module_source, {
      encoding: "utf8",
      flag: "wx",
    });
    written = true;

    const actual = await fs.readFile(outputPath, "utf8");
    const { createHash } = await import("node:crypto");
    const actualSha = createHash("sha256")
      .update(actual.replace(/\r\n/g, "\n"), "utf8")
      .digest("hex");

    if (actualSha !== preview.output.module_sha256) {
      throw new Error(
        "Materialized reviewed local module fingerprint differs from the reviewed preview. The generated file was removed.",
      );
    }

    return {
      file: preview.output.file,
      module_sha256: preview.output.module_sha256,
      source_sha256: preview.target.source_sha256,
      review_fingerprint: preview.target.review_fingerprint,
      source_modified: false,
      application_wired: false,
    };
  } catch (error) {
    if (written) {
      await fs.rm(outputPath, { force: true });
    }
    throw error;
  }
}

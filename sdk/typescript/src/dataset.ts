import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  readBenchmarkTrace,
  type BenchmarkObservation
} from "./benchmark.js";

export interface SealDatasetOptions {
  datasetId?: string;
  outputDirectory?: string;
  collectorGitCommit: string;
  sealedAt?: string;
}

export interface DatasetManifest {
  schema_version: "once-dataset-manifest-v1";
  observation_schema: "once-benchmark-observation-v1";
  trace_format: "jsonl";
  dataset_id: string;
  sealed_at: string;
  dataset_filename: string;
  sha256_filename: string;
  manifest_filename: string;
  source_trace_filename: string;
  sha256: string;
  raw_bytes: number;
  observations: number;
  unique_resources: number;
  collection_started_at: string;
  collection_ended_at: string;
  collectors: string[];
  collector_git_commit: string;
  once_decision_count: 0;
}

export interface SealDatasetResult {
  datasetPath: string;
  sha256Path: string;
  manifestPath: string;
  manifest: DatasetManifest;
}

function assertDatasetId(value: string): void {
  if (!/^\d{3,}$/u.test(value)) {
    throw new Error(
      "dataset id must contain at least three digits, for example 001."
    );
  }
}

function assertCollectorCommit(value: string): void {
  if (!/^[0-9a-f]{7,40}$/u.test(value)) {
    throw new Error(
      "collector git commit must be an explicit 7-40 character hexadecimal git commit."
    );
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }

  throw new Error(`Refusing to overwrite sealed dataset artifact: ${path}`);
}

function observationTime(
  observation: BenchmarkObservation,
  index: number
): number {
  const value = Date.parse(observation.timestamp);
  if (!Number.isFinite(value)) {
    throw new Error(
      `Invalid timestamp on observation ${index + 1}: ${observation.timestamp}`
    );
  }
  return value;
}

function collectorNames(
  observations: BenchmarkObservation[]
): string[] {
  const values = new Set<string>();

  for (const observation of observations) {
    const collector = observation.metadata?.collector;
    if (typeof collector === "string" && collector.length > 0) {
      values.add(collector);
    }
  }

  return [...values].sort();
}

export async function sealDataset(
  tracePath: string,
  options: SealDatasetOptions
): Promise<SealDatasetResult> {
  const datasetId = options.datasetId ?? "001";
  const outputDirectory = resolve(
    options.outputDirectory ?? ".once/datasets"
  );
  const collectorGitCommit = options.collectorGitCommit.toLowerCase();

  assertDatasetId(datasetId);
  assertCollectorCommit(collectorGitCommit);

  const rawTrace = await readFile(resolve(tracePath));
  const observations = await readBenchmarkTrace(tracePath);

  if (observations.length === 0) {
    throw new Error("Cannot seal an empty dataset.");
  }

  const onceDecisionCount = observations.filter(
    observation => observation.once_decision !== undefined
  ).length;

  if (onceDecisionCount > 0) {
    throw new Error(
      `Refusing to seal raw holdout: found ${onceDecisionCount} observation(s) containing once_decision.`
    );
  }

  const times = observations.map(observationTime);
  const collectionStartedAt = new Date(Math.min(...times)).toISOString();
  const collectionEndedAt = new Date(Math.max(...times)).toISOString();
  const uniqueResources = new Set(
    observations.map(observation => observation.resource)
  ).size;

  const sha256 = createHash("sha256")
    .update(rawTrace)
    .digest("hex");

  const stem = `once-dataset-${datasetId}`;
  const datasetFilename = `${stem}.jsonl`;
  const sha256Filename = `${stem}.sha256`;
  const manifestFilename = `${stem}-manifest.json`;

  const datasetPath = resolve(outputDirectory, datasetFilename);
  const sha256Path = resolve(outputDirectory, sha256Filename);
  const manifestPath = resolve(outputDirectory, manifestFilename);

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    assertAbsent(datasetPath),
    assertAbsent(sha256Path),
    assertAbsent(manifestPath)
  ]);

  const sealedAt = options.sealedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(sealedAt))) {
    throw new Error(`Invalid sealed_at timestamp: ${sealedAt}`);
  }

  const manifest: DatasetManifest = {
    schema_version: "once-dataset-manifest-v1",
    observation_schema: "once-benchmark-observation-v1",
    trace_format: "jsonl",
    dataset_id: datasetId,
    sealed_at: new Date(sealedAt).toISOString(),
    dataset_filename: datasetFilename,
    sha256_filename: sha256Filename,
    manifest_filename: manifestFilename,
    source_trace_filename: basename(tracePath),
    sha256,
    raw_bytes: rawTrace.byteLength,
    observations: observations.length,
    unique_resources: uniqueResources,
    collection_started_at: collectionStartedAt,
    collection_ended_at: collectionEndedAt,
    collectors: collectorNames(observations),
    collector_git_commit: collectorGitCommit,
    once_decision_count: 0
  };

  // The dataset bytes are written exactly as collected. No reserialization.
  await writeFile(datasetPath, rawTrace, { flag: "wx" });
  await writeFile(
    sha256Path,
    `${sha256}  ${datasetFilename}\n`,
    { encoding: "utf8", flag: "wx" }
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  );

  return {
    datasetPath,
    sha256Path,
    manifestPath,
    manifest
  };
}

export async function runDatasetSeal(
  tracePath: string,
  options: SealDatasetOptions
): Promise<SealDatasetResult> {
  const result = await sealDataset(tracePath, options);

  console.log("");
  console.log("Once Dataset Seal");
  console.log("-----------------");
  console.log(`Dataset: ${result.datasetPath}`);
  console.log(`SHA-256: ${result.manifest.sha256}`);
  console.log(`Hash file: ${result.sha256Path}`);
  console.log(`Manifest: ${result.manifestPath}`);
  console.log(`Observations: ${result.manifest.observations}`);
  console.log(`Unique resources: ${result.manifest.unique_resources}`);
  console.log(`Collection start: ${result.manifest.collection_started_at}`);
  console.log(`Collection end: ${result.manifest.collection_ended_at}`);
  console.log(`Collector commit: ${result.manifest.collector_git_commit}`);
  console.log("Policy decisions present: 0");
  console.log("Status: SEALED RAW HOLDOUT");

  return result;
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sealDataset } from "../dist/dataset.js";

const root = await mkdtemp(join(tmpdir(), "once-dataset-seal-"));

try {
  const tracePath = join(root, "agent-trace.jsonl");
  const outputDirectory = join(root, "sealed");

  const rawTrace = [
    JSON.stringify({
      timestamp: "2026-09-20T22:25:59.341Z",
      resource: "github:repo:stringsofthemind-oss/once",
      fingerprint: "a",
      latency_ms: 100,
      response_bytes: 10,
      metadata: {
        collector: "once-trace-fetch-v1"
      }
    }),
    JSON.stringify({
      timestamp: "2026-09-20T22:30:00.000Z",
      resource: "npm:package:@once-agent/sdk",
      fingerprint: "b",
      latency_ms: 200,
      response_bytes: 20,
      metadata: {
        collector: "once-trace-fetch-v1"
      }
    })
  ].join("\n") + "\n";

  await writeFile(tracePath, rawTrace, "utf8");

  const result = await sealDataset(tracePath, {
    datasetId: "001",
    outputDirectory,
    collectorGitCommit: "e79fb8c",
    sealedAt: "2026-09-21T00:00:00.000Z"
  });

  const sealedBytes = await readFile(result.datasetPath);
  assert.equal(sealedBytes.toString("utf8"), rawTrace);

  const expectedHash = createHash("sha256")
    .update(Buffer.from(rawTrace, "utf8"))
    .digest("hex");

  assert.equal(result.manifest.sha256, expectedHash);
  assert.equal(result.manifest.observations, 2);
  assert.equal(result.manifest.unique_resources, 2);
  assert.equal(result.manifest.collection_started_at, "2026-09-20T22:25:59.341Z");
  assert.equal(result.manifest.collection_ended_at, "2026-09-20T22:30:00.000Z");
  assert.deepEqual(result.manifest.collectors, ["once-trace-fetch-v1"]);
  assert.equal(result.manifest.collector_git_commit, "e79fb8c");
  assert.equal(result.manifest.once_decision_count, 0);

  const hashFile = await readFile(result.sha256Path, "utf8");
  assert.equal(
    hashFile,
    `${expectedHash}  once-dataset-001.jsonl\n`
  );

  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.schema_version, "once-dataset-manifest-v1");
  assert.equal(manifest.dataset_filename, "once-dataset-001.jsonl");

  await assert.rejects(
    () => sealDataset(tracePath, {
      datasetId: "001",
      outputDirectory,
      collectorGitCommit: "e79fb8c"
    }),
    /Refusing to overwrite sealed dataset artifact/u
  );

  const contaminatedTracePath = join(root, "contaminated.jsonl");
  await writeFile(
    contaminatedTracePath,
    `${JSON.stringify({
      timestamp: "2026-09-20T22:31:00.000Z",
      resource: "example",
      fingerprint: "x",
      once_decision: "UNCHANGED"
    })}\n`,
    "utf8"
  );

  await assert.rejects(
    () => sealDataset(contaminatedTracePath, {
      datasetId: "002",
      outputDirectory,
      collectorGitCommit: "e79fb8c"
    }),
    /containing once_decision/u
  );

  console.log("Dataset seal regression: PASS");
} finally {
  await rm(root, { recursive: true, force: true });
}

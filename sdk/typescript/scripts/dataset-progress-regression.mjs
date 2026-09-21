import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { datasetProgress } from "../dist/dataset-progress.js";

const sandbox = await mkdtemp(
  path.join(os.tmpdir(), "once-dataset-progress-")
);

const tracePath = path.join(sandbox, "trace.jsonl");
const contaminatedPath = path.join(sandbox, "contaminated.jsonl");
const preregistrationPath = path.join(sandbox, "prereg.json");

const preregistration = {
  schema_version: "once-dataset-preregistration-v1",
  dataset_id: "once-dataset-test",
  collection_start: "2026-01-01T00:00:00.000Z",
  stopping_rule: {
    type: "all_conditions_must_be_met",
    minimum_observations: 5,
    minimum_eligible_repeated_observations: 2,
    minimum_unique_resources: 3,
    minimum_collection_days: 14,
    outcome_dependent_stopping: false
  }
};

const observations = [
  {
    timestamp: "2026-01-01T00:00:00.000Z",
    resource: "resource:a",
    fingerprint: "secret-a"
  },
  {
    timestamp: "2026-01-03T00:00:00.000Z",
    resource: "resource:b",
    fingerprint: "secret-b"
  },
  {
    timestamp: "2026-01-08T00:00:00.000Z",
    resource: "resource:a",
    fingerprint: "secret-c"
  },
  {
    timestamp: "2026-01-14T00:00:00.000Z",
    resource: "resource:c",
    fingerprint: "secret-d"
  },
  {
    timestamp: "2026-01-15T00:00:00.000Z",
    resource: "resource:b",
    fingerprint: "secret-e"
  }
];

await writeFile(
  preregistrationPath,
  `${JSON.stringify(preregistration, null, 2)}\n`,
  "utf8"
);

await writeFile(
  tracePath,
  observations.map(value => JSON.stringify(value)).join("\n") + "\n",
  "utf8"
);

const progress = await datasetProgress(tracePath, preregistrationPath);

assert.equal(progress.observations, 5);
assert.equal(progress.eligible_repeated_observations, 2);
assert.equal(progress.unique_resources, 3);
assert.equal(progress.collection_days, 14);
assert.equal(progress.once_decision_count, 0);
assert.equal(progress.stop_rule_satisfied, true);
assert.equal("fingerprint" in progress, false);

const contaminated = [
  ...observations,
  {
    timestamp: "2026-01-16T00:00:00.000Z",
    resource: "resource:a",
    fingerprint: "secret-f",
    once_decision: "UNCHANGED"
  }
];

await writeFile(
  contaminatedPath,
  contaminated.map(value => JSON.stringify(value)).join("\n") + "\n",
  "utf8"
);

await assert.rejects(
  () => datasetProgress(contaminatedPath, preregistrationPath),
  /Refusing blind progress: found 1 observation\(s\) containing once_decision\./u
);

await rm(sandbox, { recursive: true, force: true });

console.log("Dataset progress regression: PASS");

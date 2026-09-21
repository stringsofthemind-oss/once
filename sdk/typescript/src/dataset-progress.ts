import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface StructuralObservation {
  timestamp?: unknown;
  resource?: unknown;
  once_decision?: unknown;
}

interface DatasetPreregistration {
  schema_version: string;
  dataset_id: string;
  collection_start: string;
  stopping_rule: {
    type: string;
    minimum_observations: number;
    minimum_eligible_repeated_observations: number;
    minimum_unique_resources: number;
    minimum_collection_days: number;
    outcome_dependent_stopping: boolean;
  };
}

export interface DatasetProgress {
  dataset_id: string;
  observations: number;
  minimum_observations: number;
  eligible_repeated_observations: number;
  minimum_eligible_repeated_observations: number;
  unique_resources: number;
  minimum_unique_resources: number;
  collection_days: number;
  minimum_collection_days: number;
  once_decision_count: 0;
  stop_rule_satisfied: boolean;
}

function finiteNonNegativeInteger(
  value: unknown,
  field: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`Invalid preregistration field: ${field}`);
  }

  return value;
}

function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string") {
    throw new Error(`Invalid timestamp field: ${field}`);
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid timestamp field: ${field}`);
  }

  return parsed;
}

async function readPreregistration(
  preregistrationPath: string
): Promise<DatasetPreregistration> {
  const raw = await readFile(resolve(preregistrationPath), "utf8");
  const parsed = JSON.parse(raw) as Partial<DatasetPreregistration>;

  if (
    parsed.schema_version !== "once-dataset-preregistration-v1" ||
    typeof parsed.dataset_id !== "string" ||
    typeof parsed.collection_start !== "string" ||
    !parsed.stopping_rule ||
    parsed.stopping_rule.type !== "all_conditions_must_be_met" ||
    parsed.stopping_rule.outcome_dependent_stopping !== false
  ) {
    throw new Error("Unsupported or invalid dataset preregistration.");
  }

  finiteNonNegativeInteger(
    parsed.stopping_rule.minimum_observations,
    "minimum_observations"
  );
  finiteNonNegativeInteger(
    parsed.stopping_rule.minimum_eligible_repeated_observations,
    "minimum_eligible_repeated_observations"
  );
  finiteNonNegativeInteger(
    parsed.stopping_rule.minimum_unique_resources,
    "minimum_unique_resources"
  );

  if (
    typeof parsed.stopping_rule.minimum_collection_days !== "number" ||
    !Number.isFinite(parsed.stopping_rule.minimum_collection_days) ||
    parsed.stopping_rule.minimum_collection_days < 0
  ) {
    throw new Error("Invalid preregistration field: minimum_collection_days");
  }

  parseTimestamp(parsed.collection_start, "collection_start");

  return parsed as DatasetPreregistration;
}

async function readStructuralObservations(
  tracePath: string
): Promise<{
  observations: number;
  uniqueResources: number;
  eligibleRepeatedObservations: number;
  latestTimestamp: number;
}> {
  const raw = await readFile(resolve(tracePath), "utf8");
  const lines = raw
    .split(/\r?\n/u)
    .filter(line => line.trim().length > 0);

  if (lines.length === 0) {
    throw new Error("Dataset progress requires a non-empty trace.");
  }

  const resources = new Set<string>();
  let repeats = 0;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  let onceDecisionCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const observation = JSON.parse(lines[index]) as StructuralObservation;

    if (
      typeof observation.resource !== "string" ||
      observation.resource.length === 0
    ) {
      throw new Error(`Invalid resource on observation ${index + 1}.`);
    }

    const timestamp = parseTimestamp(
      observation.timestamp,
      `observation ${index + 1}`
    );
    latestTimestamp = Math.max(latestTimestamp, timestamp);

    if (resources.has(observation.resource)) {
      repeats += 1;
    } else {
      resources.add(observation.resource);
    }

    if (observation.once_decision !== undefined) {
      onceDecisionCount += 1;
    }
  }

  if (onceDecisionCount > 0) {
    throw new Error(
      `Refusing blind progress: found ${onceDecisionCount} observation(s) containing once_decision.`
    );
  }

  return {
    observations: lines.length,
    uniqueResources: resources.size,
    eligibleRepeatedObservations: repeats,
    latestTimestamp
  };
}

export async function datasetProgress(
  tracePath: string,
  preregistrationPath: string
): Promise<DatasetProgress> {
  const preregistration = await readPreregistration(preregistrationPath);
  const structural = await readStructuralObservations(tracePath);

  const collectionStart = parseTimestamp(
    preregistration.collection_start,
    "collection_start"
  );

  if (structural.latestTimestamp < collectionStart) {
    throw new Error(
      "Latest observation predates the preregistered collection start."
    );
  }

  const collectionDays =
    (structural.latestTimestamp - collectionStart) /
    86_400_000;

  const minimumObservations = finiteNonNegativeInteger(
    preregistration.stopping_rule.minimum_observations,
    "minimum_observations"
  );
  const minimumRepeated = finiteNonNegativeInteger(
    preregistration.stopping_rule.minimum_eligible_repeated_observations,
    "minimum_eligible_repeated_observations"
  );
  const minimumUnique = finiteNonNegativeInteger(
    preregistration.stopping_rule.minimum_unique_resources,
    "minimum_unique_resources"
  );
  const minimumDays = preregistration.stopping_rule.minimum_collection_days;

  const stopRuleSatisfied =
    structural.observations >= minimumObservations &&
    structural.eligibleRepeatedObservations >= minimumRepeated &&
    structural.uniqueResources >= minimumUnique &&
    collectionDays >= minimumDays;

  return {
    dataset_id: preregistration.dataset_id,
    observations: structural.observations,
    minimum_observations: minimumObservations,
    eligible_repeated_observations: structural.eligibleRepeatedObservations,
    minimum_eligible_repeated_observations: minimumRepeated,
    unique_resources: structural.uniqueResources,
    minimum_unique_resources: minimumUnique,
    collection_days: collectionDays,
    minimum_collection_days: minimumDays,
    once_decision_count: 0,
    stop_rule_satisfied: stopRuleSatisfied
  };
}

export async function runDatasetProgress(
  tracePath: string,
  preregistrationPath: string
): Promise<DatasetProgress> {
  const progress = await datasetProgress(tracePath, preregistrationPath);

  console.log("");
  console.log("Once Dataset Progress");
  console.log("---------------------");
  console.log(`Dataset: ${progress.dataset_id}`);
  console.log(
    `Observations: ${progress.observations} / ${progress.minimum_observations}`
  );
  console.log(
    `Eligible repeated observations: ${progress.eligible_repeated_observations} / ${progress.minimum_eligible_repeated_observations}`
  );
  console.log(
    `Unique resources: ${progress.unique_resources} / ${progress.minimum_unique_resources}`
  );
  console.log(
    `Collection span: ${progress.collection_days.toFixed(2)} / ${progress.minimum_collection_days} days`
  );
  console.log("Policy decisions present: 0");
  console.log("Fingerprint outcomes inspected: NO");
  console.log(
    `Stop rule satisfied: ${progress.stop_rule_satisfied ? "YES" : "NO"}`
  );
  console.log(
    `Status: ${progress.stop_rule_satisfied ? "READY TO SEAL" : "COLLECTING"}`
  );

  return progress;
}

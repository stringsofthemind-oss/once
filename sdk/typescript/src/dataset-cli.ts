#!/usr/bin/env node

import { runDatasetSeal } from "./dataset.js";

function argumentValue(
  args: string[],
  prefix: string
): string | undefined {
  const value = args.find(argument => argument.startsWith(prefix));
  return value?.substring(prefix.length);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = (args.shift() ?? "").toLowerCase();

  if (command !== "seal") {
    throw new Error(
      "Usage: once-dataset seal <trace.jsonl> --collector-commit=<git-sha> [--id=001] [--out=.once/datasets]"
    );
  }

  const tracePath = args.find(value => !value.startsWith("--"));
  if (!tracePath) {
    throw new Error("dataset seal requires a source JSONL trace path.");
  }

  const collectorGitCommit = argumentValue(args, "--collector-commit=");
  if (!collectorGitCommit) {
    throw new Error(
      "dataset seal requires --collector-commit=<git-sha>; provenance must be explicit, never inferred later."
    );
  }

  await runDatasetSeal(tracePath, {
    datasetId: argumentValue(args, "--id="),
    outputDirectory: argumentValue(args, "--out="),
    collectorGitCommit
  });
}

try {
  await main();
} catch (error) {
  console.error("");
  console.error("Once dataset command failed.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

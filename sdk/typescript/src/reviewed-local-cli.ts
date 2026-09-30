import path from "node:path";

import {
  REVIEWED_LOCAL_SEMANTICS_FILE,
  writeReviewedLocalSemanticsPlan,
} from "./reviewed-local-semantics.js";

function optionValue(
  args: readonly string[],
  name: string,
): string | undefined {
  const bare = `--${name}`;
  const prefix = `${bare}=`;
  const matches = args.filter(value => value.startsWith(prefix));

  if (args.includes(bare)) {
    throw new Error(`${bare} requires an explicit value.`);
  }
  if (matches.length > 1) {
    throw new Error(`${bare} may be supplied only once.`);
  }
  if (matches.length === 0) return undefined;

  const value = matches[0]!.slice(prefix.length).trim();
  if (!value) {
    throw new Error(`${bare} requires a nonempty value.`);
  }
  return value;
}

export async function runReviewedLocalCli(
  args: readonly string[],
): Promise<void> {
  const allowed = args.every(
    value =>
      !value.startsWith("--") ||
      value === "--confirm-reviewed" ||
      value.startsWith("--target=") ||
      value.startsWith("--id-prefix=") ||
      value.startsWith("--id-path=") ||
      value.startsWith("--payload-paths="),
  );

  if (!allowed) {
    throw new Error(
      "review-local received an unsupported option. Supported options are --target=, --id-prefix=, --id-path=, --payload-paths= and --confirm-reviewed.",
    );
  }

  const positionals = args.filter(value => !value.startsWith("--"));
  if (positionals.length > 1) {
    throw new Error("review-local accepts at most one project directory.");
  }

  const requestedPath = positionals[0] ?? ".";
  const target = optionValue(args, "target");
  const idPrefix = optionValue(args, "id-prefix");
  const idPath = optionValue(args, "id-path");
  const payloadRaw = optionValue(args, "payload-paths");
  const confirmReviewed = args.includes("--confirm-reviewed");

  if (
    target === undefined ||
    idPrefix === undefined ||
    idPath === undefined ||
    payloadRaw === undefined
  ) {
    throw new Error(
      "review-local requires --target=<file:function>, --id-prefix=<prefix>, --id-path=<path> and --payload-paths=<path1,path2,...>. Once does not infer these semantics.",
    );
  }

  if (!confirmReviewed) {
    throw new Error(
      "review-local is review-only and requires --confirm-reviewed after you have explicitly checked the stable logical identity and every effect-bearing payload path. No artifact was written.",
    );
  }

  const payloadPaths = payloadRaw.split(",").map(value => value.trim());
  if (payloadPaths.some(value => value.length === 0)) {
    throw new Error(
      "--payload-paths must be a comma-separated list of nonempty input paths.",
    );
  }

  const plan = await writeReviewedLocalSemanticsPlan(requestedPath, {
    target,
    idPrefix,
    idPath,
    payloadPaths,
    confirmReviewed: true,
  });

  const planPath = path.join(
    path.resolve(requestedPath),
    ".once",
    REVIEWED_LOCAL_SEMANTICS_FILE,
  );

  console.log("");
  console.log("Once Reviewed Local Semantics");
  console.log("=============================");
  console.log(`Target: ${plan.target.file}:${plan.target.function_name}`);
  console.log(
    `Observed candidate: ${plan.target.candidate.confidence} · ${plan.target.candidate.category} · ${plan.target.candidate.automation_status}`,
  );
  if (plan.target.source_observations.top_level_fields.length > 0) {
    console.log(
      `Observed top-level inputs: ${plan.target.source_observations.top_level_fields.join(", ")} (observation only)`,
    );
  } else {
    console.log(
      `Observed input shape: ${plan.target.source_observations.parameter_shape} (no field semantics inferred)`,
    );
  }
  console.log(`Reviewed identity prefix: ${JSON.stringify(plan.review.identity.prefix)}`);
  console.log(`Reviewed identity path: ${plan.review.identity.path}`);
  console.log(`Reviewed payload paths: ${plan.review.payload.paths.join(", ")}`);
  console.log(`Review artifact: ${planPath}`);
  console.log("Developer confirmed: yes");
  console.log("Source modified: no");
  console.log("Runnable: no");
  console.log("");
  console.log(
    "This artifact records developer-reviewed semantics only. It does not generate, apply, or execute protection.",
  );
  console.log(
    "Once has not inferred business identity or payload completeness; those choices are the explicit review recorded above.",
  );
}

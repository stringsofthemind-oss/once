import path from "node:path";

import {
  materializeReviewedLocalCompanion,
} from "./reviewed-local-materialize.js";
import {
  buildReviewedLocalProtectionPreview,
} from "./reviewed-local-preview.js";
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

function hasSemanticOption(args: readonly string[]): boolean {
  return args.some(
    value =>
      value === "--confirm-reviewed" ||
      value.startsWith("--target=") ||
      value.startsWith("--id-prefix=") ||
      value.startsWith("--id-path=") ||
      value.startsWith("--payload-paths="),
  );
}

async function printReviewedLocalPreview(requestedPath: string): Promise<void> {
  const preview = await buildReviewedLocalProtectionPreview(requestedPath);

  console.log("");
  console.log("Once Reviewed Local Protection Preview");
  console.log("======================================");
  console.log(`Target: ${preview.target.file}:${preview.target.function_name}`);
  console.log(`Source SHA-256: ${preview.target.source_sha256}`);
  console.log(`Review fingerprint: ${preview.target.review_fingerprint}`);
  console.log(`Proposed module: ${preview.output.file}`);
  console.log(`Module SHA-256: ${preview.output.module_sha256}`);
  console.log("Source modified: no");
  console.log("Generated file written: no");
  console.log("Runnable integration active: no");
  console.log("");
  console.log("Preview module source:");
  console.log("----------------------");
  process.stdout.write(preview.output.module_source);
  console.log("");
  console.log(
    "Preview only: Once did not write this module, alter the target source, or change any application import/call site.",
  );
  console.log(
    "Boundary: the proposed wrapper uses same-machine protectLocal state and requires Node.js 24.15+ when eventually executed. This is not a multi-host or universal exactly-once guarantee.",
  );
  console.log("After reviewing this exact preview, materialize it explicitly with:");
  console.log(
    `  npx --yes --package=@once-agent/sdk once review-local ${JSON.stringify(requestedPath)} --materialize --confirm-materialize`,
  );
}

async function printReviewedLocalMaterialization(
  requestedPath: string,
): Promise<void> {
  const result = await materializeReviewedLocalCompanion(requestedPath);

  console.log("");
  console.log("Once Reviewed Local Companion Materialized");
  console.log("==========================================");
  console.log(`Generated module: ${result.file}`);
  console.log(`Module SHA-256: ${result.module_sha256}`);
  console.log(`Target source SHA-256: ${result.source_sha256}`);
  console.log(`Review fingerprint: ${result.review_fingerprint}`);
  console.log("Application source modified: no");
  console.log("Application import/call site modified: no");
  console.log("Application integration active: no");
  console.log("");
  console.log(
    "The reviewed protected companion module now exists, but Once did not wire your application to it. Import/use this generated export only after deliberate call-site review.",
  );
  console.log(
    "Boundary: the generated wrapper uses durable same-machine protectLocal state on Node.js 24.15+. This is not a multi-host or universal exactly-once guarantee.",
  );
}

export async function runReviewedLocalCli(
  args: readonly string[],
): Promise<void> {
  const allowed = args.every(
    value =>
      !value.startsWith("--") ||
      value === "--confirm-reviewed" ||
      value === "--preview" ||
      value === "--materialize" ||
      value === "--confirm-materialize" ||
      value.startsWith("--target=") ||
      value.startsWith("--id-prefix=") ||
      value.startsWith("--id-path=") ||
      value.startsWith("--payload-paths="),
  );

  if (!allowed) {
    throw new Error(
      "review-local received an unsupported option. Supported options are --target=, --id-prefix=, --id-path=, --payload-paths=, --confirm-reviewed, --preview, --materialize and --confirm-materialize.",
    );
  }

  const positionals = args.filter(value => !value.startsWith("--"));
  if (positionals.length > 1) {
    throw new Error("review-local accepts at most one project directory.");
  }

  const requestedPath = positionals[0] ?? ".";
  const preview = args.includes("--preview");
  const materialize = args.includes("--materialize");
  const confirmMaterialize = args.includes("--confirm-materialize");

  if (preview && materialize) {
    throw new Error(
      "review-local preview and materialization are separate review gates. Run --preview first, then --materialize --confirm-materialize.",
    );
  }

  if (preview) {
    if (hasSemanticOption(args) || confirmMaterialize) {
      throw new Error(
        "review-local --preview uses only the already-reviewed .once/reviewed-local-semantics.json artifact and does not accept semantic or materialization confirmation options. Review first, then preview separately.",
      );
    }
    await printReviewedLocalPreview(requestedPath);
    return;
  }

  if (materialize) {
    if (hasSemanticOption(args)) {
      throw new Error(
        "review-local --materialize uses only the already-reviewed semantics and deterministic preview; it does not accept semantic review options.",
      );
    }
    if (!confirmMaterialize) {
      throw new Error(
        "review-local --materialize requires --confirm-materialize after you have reviewed the exact preview. No generated file was written.",
      );
    }
    await printReviewedLocalMaterialization(requestedPath);
    return;
  }

  if (confirmMaterialize) {
    throw new Error(
      "--confirm-materialize is valid only with --materialize after a separate preview step.",
    );
  }

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
  console.log("Preview the deterministic companion wrapper without writing source or generated files with:");
  console.log(
    `  npx --yes --package=@once-agent/sdk once review-local ${JSON.stringify(requestedPath)} --preview`,
  );
}

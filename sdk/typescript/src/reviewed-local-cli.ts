import path from "node:path";

import {
  inventoryReviewedLocalCallers,
} from "./reviewed-local-caller-inventory.js";
import {
  materializeReviewedLocalCompanion,
} from "./reviewed-local-materialize.js";
import {
  buildReviewedLocalProtectionPreview,
} from "./reviewed-local-preview.js";
import {
  REVIEWED_LOCAL_ROUTING_APPLY_FILE,
  applyReviewedLocalRouting,
} from "./reviewed-local-routing-apply.js";
import {
  buildReviewedLocalRoutingPreview,
} from "./reviewed-local-routing-preview.js";
import {
  REVIEWED_LOCAL_ROUTING_REVIEW_FILE,
  writeReviewedLocalRoutingReview,
} from "./reviewed-local-routing-review.js";
import {
  REVIEWED_LOCAL_SEMANTICS_FILE,
  writeReviewedLocalSemanticsPlan,
} from "./reviewed-local-semantics.js";

function optionValue(args: readonly string[], name: string): string | undefined {
  const bare = `--${name}`;
  const prefix = `${bare}=`;
  const matches = args.filter(value => value.startsWith(prefix));
  if (args.includes(bare)) throw new Error(`${bare} requires an explicit value.`);
  if (matches.length > 1) throw new Error(`${bare} may be supplied only once.`);
  if (matches.length === 0) return undefined;
  const value = matches[0]!.slice(prefix.length).trim();
  if (!value) throw new Error(`${bare} requires a nonempty value.`);
  return value;
}

function hasSemanticOption(args: readonly string[]): boolean {
  return args.some(value =>
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
  console.log("Preview only: Once did not write this module, alter the target source, or change any application import/call site.");
  console.log("Boundary: the proposed wrapper uses same-machine protectLocal state and requires Node.js 24.15+ when eventually executed. This is not a multi-host or universal exactly-once guarantee.");
  console.log("After reviewing this exact preview, materialize it explicitly with:");
  console.log(`  npx --yes --package=@once-agent/sdk once review-local ${JSON.stringify(requestedPath)} --materialize --confirm-materialize`);
}

async function printReviewedLocalMaterialization(requestedPath: string): Promise<void> {
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
  console.log("The reviewed protected companion module now exists, but Once did not wire your application to it.");
  console.log("Boundary: the generated wrapper uses durable same-machine protectLocal state on Node.js 24.15+. This is not a multi-host or universal exactly-once guarantee.");
  console.log("Inventory only statically provable direct callers without changing application source with:");
  console.log(`  npx --yes --package=@once-agent/sdk once review-local ${JSON.stringify(requestedPath)} --inventory-callers`);
}

async function printReviewedLocalCallerInventory(requestedPath: string): Promise<void> {
  const inventory = await inventoryReviewedLocalCallers(requestedPath);
  const callSiteCount = inventory.callers.reduce((total, caller) => total + caller.call_sites.length, 0);
  console.log("");
  console.log("Once Reviewed Local Caller Inventory");
  console.log("====================================");
  console.log(`Target: ${inventory.target.file}:${inventory.target.function_name}`);
  console.log(`Verified companion: ${inventory.companion.file}`);
  console.log(`Status: ${inventory.status}`);
  console.log(`Proven caller modules: ${inventory.callers.length}`);
  console.log(`Proven direct call sites: ${callSiteCount}`);
  console.log(`Blocking ambiguities: ${inventory.blockers.length}`);
  console.log("Application source modified: no");
  console.log("Generated companion modified: no");
  console.log("Application integration active: no");

  for (const caller of inventory.callers) {
    console.log("");
    console.log(`Caller: ${caller.file} imports ${caller.import.imported_name} as ${caller.import.local_name}`);
    for (const callSite of caller.call_sites) {
      console.log(`  direct call at ${callSite.line}:${callSite.column} · ${callSite.call_sha256}`);
    }
  }
  for (const blocker of inventory.blockers) {
    console.log("");
    const location = blocker.line === null ? blocker.file : `${blocker.file}:${blocker.line}:${blocker.column ?? 1}`;
    console.log(`BLOCKED ${blocker.kind} at ${location}`);
    console.log(`  ${blocker.reason}`);
  }

  console.log("");
  console.log("Deterministic evidence:");
  console.log(JSON.stringify(inventory, null, 2));
  console.log("");
  console.log("Inventory only: Once did not rewrite imports, call sites, the target operation, or the generated companion.");
  console.log("Proof boundary: caller-inventory v1 recognizes only exact relative static ESM imports of the reviewed function and direct calls through that binding. Re-exports, dynamic imports, shadowing, symlinked project entries and indirect value flow block routing rather than being guessed.");
  if (inventory.status === "BLOCKED") {
    console.log("Routing must remain inactive while any blocking ambiguity is present.");
  } else if (inventory.status === "READY_FOR_ROUTING_REVIEW") {
    console.log("Preview the exact caller import replacement without changing application source with:");
    console.log(`  npx --yes --package=@once-agent/sdk once review-local ${JSON.stringify(requestedPath)} --preview-routing`);
  }
}

async function printReviewedLocalRoutingPreview(requestedPath: string): Promise<void> {
  const preview = await buildReviewedLocalRoutingPreview(requestedPath);
  console.log("");
  console.log("Once Reviewed Local Routing Preview");
  console.log("===================================");
  console.log(`Target: ${preview.target.file}:${preview.target.function_name}`);
  console.log(`Verified companion: ${preview.companion.file}`);
  console.log(`Inventory fingerprint: ${preview.inventory_fingerprint}`);
  console.log(`Status: ${preview.status}`);
  console.log(`Proposed caller import changes: ${preview.routes.length}`);
  console.log(`Blocking ambiguities: ${preview.blockers.length}`);
  console.log("Application source modified: no");
  console.log("Generated companion modified: no");
  console.log("Application integration active: no");

  for (const route of preview.routes) {
    console.log("");
    console.log(`Caller: ${route.file}:${route.import_line}`);
    console.log(`  Imported binding: ${route.imported_name} as ${route.local_name}`);
    console.log(`  Proven direct calls: ${route.direct_call_count}`);
    console.log(`  Before: ${route.replacement.before}`);
    console.log(`  After:  ${route.replacement.after}`);
    console.log(`  Source SHA-256: ${route.source_sha256}`);
    console.log(`  Preview result SHA-256: ${route.result_source_sha256}`);
  }
  for (const blocker of preview.blockers) {
    console.log("");
    const location = blocker.line === null ? blocker.file : `${blocker.file}:${blocker.line}:${blocker.column ?? 1}`;
    console.log(`BLOCKED ${blocker.kind} at ${location}`);
    console.log(`  ${blocker.reason}`);
  }

  console.log("");
  console.log("Deterministic preview evidence:");
  console.log(JSON.stringify(preview, null, 2));
  console.log("");
  console.log("Preview only: Once did not change any application import, call site, target operation, or generated companion.");
  console.log("Routing preview v1 changes only the exact module-specifier literal of a proven single-binding static ESM import. Mixed imports and ambiguous caller forms remain blocked rather than being rewritten.");
  if (preview.status === "PATCHABLE_PREVIEW") {
    console.log("After reviewing every exact route above, record explicit developer approval with:");
    console.log(`  npx --yes --package=@once-agent/sdk once review-local ${JSON.stringify(requestedPath)} --review-routing --confirm-routing-reviewed`);
  } else {
    console.log("Routing cannot be approved unless the current routing preview is PATCHABLE_PREVIEW.");
  }
}

async function printReviewedLocalRoutingReview(requestedPath: string): Promise<void> {
  const review = await writeReviewedLocalRoutingReview(requestedPath, true);
  const reviewPath = path.join(path.resolve(requestedPath), ".once", REVIEWED_LOCAL_ROUTING_REVIEW_FILE);
  console.log("");
  console.log("Once Reviewed Local Routing Approved");
  console.log("====================================");
  console.log(`Target: ${review.review.target.file}:${review.review.target.function_name}`);
  console.log(`Verified companion: ${review.review.companion.file}`);
  console.log(`Reviewed routes: ${review.review.routes.length}`);
  console.log(`Inventory fingerprint: ${review.review.inventory_fingerprint}`);
  console.log(`Routing review fingerprint: ${review.review.routing_review_fingerprint}`);
  console.log(`Review artifact: ${reviewPath}`);
  console.log("Developer confirmed: yes");
  console.log("Application source modified: no");
  console.log("Generated companion modified: no");
  console.log("Application integration active: no");
  console.log("");
  console.log("This write-once artifact records approval of the exact routing preview only. It does not apply any routing change.");
  console.log("After reviewing this approval artifact, apply only the exact reviewed routes transactionally with:");
  console.log(`  npx --yes --package=@once-agent/sdk once review-local ${JSON.stringify(requestedPath)} --apply-routing --confirm-routing-apply`);
  console.log("Apply requires Node.js 24.15+ and revalidates the review fingerprint, companion, caller inventory and every caller source immediately before mutation.");
}

async function printReviewedLocalRoutingApply(requestedPath: string): Promise<void> {
  const receipt = await applyReviewedLocalRouting(requestedPath, true);
  const receiptPath = path.join(path.resolve(requestedPath), ".once", REVIEWED_LOCAL_ROUTING_APPLY_FILE);
  console.log("");
  console.log("Once Reviewed Local Routing Applied");
  console.log("===================================");
  console.log(`Target: ${receipt.target.file}:${receipt.target.function_name}`);
  console.log(`Verified companion: ${receipt.companion.file}`);
  console.log(`Applied caller modules: ${receipt.files.length}`);
  console.log(`Inventory fingerprint: ${receipt.inventory_fingerprint}`);
  console.log(`Routing review fingerprint: ${receipt.routing_review_fingerprint}`);
  console.log(`Apply receipt: ${receiptPath}`);
  for (const file of receipt.files) {
    console.log("");
    console.log(`Caller: ${file.file}`);
    console.log(`  Original SHA-256: ${file.source_sha256}`);
    console.log(`  Applied SHA-256: ${file.applied_sha256}`);
    console.log(`  Backup: ${file.backup_file}`);
  }
  console.log("");
  console.log("Application source modified: yes");
  console.log("Generated companion modified: no");
  console.log("Application integration active: yes");
  console.log("Only the exact developer-reviewed caller import module specifiers were changed; the target operation and call expressions were not rewritten.");
  console.log("Boundary: the active generated companion uses durable same-machine protectLocal state on Node.js 24.15+. This is not a multi-host or universal exactly-once guarantee.");
}

export async function runReviewedLocalCli(args: readonly string[]): Promise<void> {
  const allowed = args.every(value =>
    !value.startsWith("--") ||
    value === "--confirm-reviewed" ||
    value === "--preview" ||
    value === "--materialize" ||
    value === "--confirm-materialize" ||
    value === "--inventory-callers" ||
    value === "--preview-routing" ||
    value === "--review-routing" ||
    value === "--confirm-routing-reviewed" ||
    value === "--apply-routing" ||
    value === "--confirm-routing-apply" ||
    value.startsWith("--target=") ||
    value.startsWith("--id-prefix=") ||
    value.startsWith("--id-path=") ||
    value.startsWith("--payload-paths="),
  );
  if (!allowed) {
    throw new Error("review-local received an unsupported option. Supported options are --target=, --id-prefix=, --id-path=, --payload-paths=, --confirm-reviewed, --preview, --materialize, --confirm-materialize, --inventory-callers, --preview-routing, --review-routing, --confirm-routing-reviewed, --apply-routing and --confirm-routing-apply.");
  }

  const positionals = args.filter(value => !value.startsWith("--"));
  if (positionals.length > 1) throw new Error("review-local accepts at most one project directory.");

  const requestedPath = positionals[0] ?? ".";
  const preview = args.includes("--preview");
  const materialize = args.includes("--materialize");
  const confirmMaterialize = args.includes("--confirm-materialize");
  const inventoryCallers = args.includes("--inventory-callers");
  const previewRouting = args.includes("--preview-routing");
  const reviewRouting = args.includes("--review-routing");
  const confirmRoutingReviewed = args.includes("--confirm-routing-reviewed");
  const applyRouting = args.includes("--apply-routing");
  const confirmRoutingApply = args.includes("--confirm-routing-apply");
  const selectedModes = [preview, materialize, inventoryCallers, previewRouting, reviewRouting, applyRouting].filter(Boolean).length;

  if (selectedModes > 1) {
    throw new Error("review-local protection preview, materialization, caller inventory, routing preview, routing review and routing apply are separate gates. Select only one mode per invocation.");
  }

  if (preview) {
    if (hasSemanticOption(args) || confirmMaterialize || confirmRoutingReviewed || confirmRoutingApply) {
      throw new Error("review-local --preview uses only the already-reviewed .once/reviewed-local-semantics.json artifact and does not accept review confirmation options. Review first, then preview separately.");
    }
    await printReviewedLocalPreview(requestedPath);
    return;
  }

  if (materialize) {
    if (hasSemanticOption(args) || confirmRoutingReviewed || confirmRoutingApply) {
      throw new Error("review-local --materialize uses only the already-reviewed semantics and deterministic preview; it does not accept semantic review options or routing review/apply options.");
    }
    if (!confirmMaterialize) {
      throw new Error("review-local --materialize requires --confirm-materialize after you have reviewed the exact preview. No generated file was written.");
    }
    await printReviewedLocalMaterialization(requestedPath);
    return;
  }

  if (inventoryCallers) {
    if (hasSemanticOption(args) || confirmMaterialize || confirmRoutingReviewed || confirmRoutingApply) {
      throw new Error("review-local --inventory-callers uses only the already-reviewed semantics and exact materialized companion; it does not accept review confirmation options.");
    }
    await printReviewedLocalCallerInventory(requestedPath);
    return;
  }

  if (previewRouting) {
    if (hasSemanticOption(args) || confirmMaterialize || confirmRoutingReviewed || confirmRoutingApply) {
      throw new Error("review-local --preview-routing uses only exact reviewed semantics, the verified materialized companion and current caller inventory; it does not accept review confirmation options.");
    }
    await printReviewedLocalRoutingPreview(requestedPath);
    return;
  }

  if (reviewRouting) {
    if (hasSemanticOption(args) || confirmMaterialize || confirmRoutingApply) {
      throw new Error("review-local --review-routing records only the exact current routing preview and does not accept semantic, materialization or routing apply options.");
    }
    if (!confirmRoutingReviewed) {
      throw new Error("review-local --review-routing requires --confirm-routing-reviewed after you have reviewed every exact route. No routing review artifact was written.");
    }
    await printReviewedLocalRoutingReview(requestedPath);
    return;
  }

  if (applyRouting) {
    if (hasSemanticOption(args) || confirmMaterialize || confirmRoutingReviewed) {
      throw new Error("review-local --apply-routing uses only the immutable routing review artifact and fresh source evidence; it does not accept semantic, materialization or routing-review confirmation options.");
    }
    if (!confirmRoutingApply) {
      throw new Error("review-local --apply-routing requires --confirm-routing-apply after the separate routing review gate. Application source was not modified.");
    }
    await printReviewedLocalRoutingApply(requestedPath);
    return;
  }

  if (confirmMaterialize) {
    throw new Error("--confirm-materialize is valid only with --materialize after a separate preview step.");
  }
  if (confirmRoutingReviewed) {
    throw new Error("--confirm-routing-reviewed is valid only with --review-routing after a separate routing preview step.");
  }
  if (confirmRoutingApply) {
    throw new Error("--confirm-routing-apply is valid only with --apply-routing after a separate routing review step.");
  }

  const target = optionValue(args, "target");
  const idPrefix = optionValue(args, "id-prefix");
  const idPath = optionValue(args, "id-path");
  const payloadRaw = optionValue(args, "payload-paths");
  const confirmReviewed = args.includes("--confirm-reviewed");
  if (target === undefined || idPrefix === undefined || idPath === undefined || payloadRaw === undefined) {
    throw new Error("review-local requires --target=<file:function>, --id-prefix=<prefix>, --id-path=<path> and --payload-paths=<path1,path2,...>. Once does not infer these semantics.");
  }
  if (!confirmReviewed) {
    throw new Error("review-local is review-only and requires --confirm-reviewed after you have explicitly checked the stable logical identity and every effect-bearing payload path. No artifact was written.");
  }

  const payloadPaths = payloadRaw.split(",").map(value => value.trim());
  if (payloadPaths.some(value => value.length === 0)) {
    throw new Error("--payload-paths must be a comma-separated list of nonempty input paths.");
  }

  const plan = await writeReviewedLocalSemanticsPlan(requestedPath, {
    target,
    idPrefix,
    idPath,
    payloadPaths,
    confirmReviewed: true,
  });
  const planPath = path.join(path.resolve(requestedPath), ".once", REVIEWED_LOCAL_SEMANTICS_FILE);

  console.log("");
  console.log("Once Reviewed Local Semantics");
  console.log("=============================");
  console.log(`Target: ${plan.target.file}:${plan.target.function_name}`);
  console.log(`Observed candidate: ${plan.target.candidate.confidence} · ${plan.target.candidate.category} · ${plan.target.candidate.automation_status}`);
  if (plan.target.source_observations.top_level_fields.length > 0) {
    console.log(`Observed top-level inputs: ${plan.target.source_observations.top_level_fields.join(", ")} (observation only)`);
  } else {
    console.log(`Observed input shape: ${plan.target.source_observations.parameter_shape} (no field semantics inferred)`);
  }
  console.log(`Reviewed identity prefix: ${JSON.stringify(plan.review.identity.prefix)}`);
  console.log(`Reviewed identity path: ${plan.review.identity.path}`);
  console.log(`Reviewed payload paths: ${plan.review.payload.paths.join(", ")}`);
  console.log(`Review artifact: ${planPath}`);
  console.log("Developer confirmed: yes");
  console.log("Source modified: no");
  console.log("Runnable: no");
  console.log("");
  console.log("This artifact records developer-reviewed semantics only. It does not generate, apply, or execute protection.");
  console.log("Once has not inferred business identity or payload completeness; those choices are the explicit review recorded above.");
  console.log("Preview the deterministic companion wrapper without writing source or generated files with:");
  console.log(`  npx --yes --package=@once-agent/sdk once review-local ${JSON.stringify(requestedPath)} --preview`);
}

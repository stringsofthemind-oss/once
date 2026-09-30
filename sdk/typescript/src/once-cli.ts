#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Zero-friction package entry point.
 *
 * Keep the mature CLI implementation in cli.ts as the execution authority.
 * This wrapper chooses the safest useful default for bare `once` / `npx once`
 * and owns the explicit Phase 16E local-function bridge command so the
 * existing Doctor/Protect apply engine remains unchanged.
 *
 * - No arguments + no API key: run local discovery and generate the automatic
 *   protection plan. Do not mutate source or contact the network.
 * - No arguments + ONCE_API_KEY: run the proven Phase 15 protection pipeline,
 *   including transactional apply and route-matched hostile-retry verification.
 * - `protect-local`: use the separately pinned local-function plan/apply path.
 * - Any other explicit arguments: preserve the existing CLI exactly.
 */

const explicitArgs = process.argv.slice(2);
const zeroFriction = explicitArgs.length === 0;
const startedAt = performance.now();
const command = (explicitArgs[0] ?? "").toLowerCase();
const LOCAL_FUNCTION_GUIDE =
  "https://github.com/stringsofthemind-oss/once/tree/main/examples/local-function";

function optionValue(
  args: string[],
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

  const value = matches[0]!.slice(prefix.length);
  if (!value.trim()) {
    throw new Error(`${bare} requires a nonempty value.`);
  }

  return value;
}

function printLocalFunctionHelp(): void {
  console.log("");
  console.log("Local-function bridge (explicit ESM .mjs BOOKING/order v1):");
  console.log(
    "  once protect-local [directory] --target=<file:function> --id-prefix=<prefix> --id-field=<field>"
  );
  console.log(
    "      Validate the pinned local-function contract and write .once/local-function-protect-plan.json. Source is not modified."
  );
  console.log(
    "  once protect-local [directory] --apply"
  );
  console.log(
    "      Apply the already-reviewed local-function plan after full stale-source and contract revalidation. Requires Node.js 24.15+."
  );
  console.log(
    "      Identity is never inferred. The prefix and field must identify one intentional real-world action across retries."
  );
}

function printDoctorLocalBridgeGuidance(): void {
  console.log("");
  console.log("LOCAL BOOKING/ORDER BRIDGE");
  console.log("--------------------------");
  console.log(
    "If a BOOKING/order candidate above remains ADAPTER_REQUIRED and is an explicit .mjs local function, Once can separately validate the pinned single-host local-function bridge."
  );
  console.log(
    "This does not make the candidate automatically patchable and Once will not infer logical identity."
  );
  console.log("Create a review plan by replacing these example values with your exact function and stable identity:");
  console.log(
    "  npx --yes --package=@once-agent/sdk once protect-local . --target=orders.mjs:createOrder --id-prefix=create-order --id-field=orderId"
  );
  console.log("Review .once/local-function-protect-plan.json, then apply explicitly with:");
  console.log(
    "  npx --yes --package=@once-agent/sdk once protect-local . --apply"
  );
  console.log(
    "Apply/runtime requires Node.js 24.15+. Unsupported, ambiguous, stale or symlinked source fails closed with application source unchanged."
  );
  console.log("");
  console.log("MANUAL LOCAL FALLBACK");
  console.log("---------------------");
  console.log(
    "If the scanner leaves a local write at MANUAL_REVIEW, does not establish BOOKING/order semantics, or protect-local rejects the pinned source shape, do not reshape code just to force bridge eligibility."
  );
  console.log(
    "The supported fallback is to wrap the existing async function with protectLocal after you explicitly choose a stable logical action id and include every effect-bearing input in payload."
  );
  console.log("Once does not infer either choice for the manual route.");
  console.log(`Guide: ${LOCAL_FUNCTION_GUIDE}`);
}

type ProtectPlanCandidate = Readonly<{
  file?: unknown;
  function_name?: unknown;
  confidence?: unknown;
  category?: unknown;
  automation_status?: unknown;
  auto_apply_eligible?: unknown;
}>;

function observedDestructuredFields(
  source: string,
  functionName: string,
): string[] {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(\\s*\\{([^}]*)\\}\\s*\\)`,
      "m",
    ),
    new RegExp(
      `(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?\\(\\s*\\{([^}]*)\\}\\s*\\)\\s*=>`,
      "m",
    ),
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const raw = match?.[1];
    if (raw === undefined) continue;

    const parts = raw
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);
    if (parts.length === 0) return [];

    const fields: string[] = [];
    for (const part of parts) {
      const simple = part.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
      if (!simple?.[1]) return [];
      fields.push(simple[1]);
    }

    return fields;
  }

  return [];
}

function doctorRequestedPath(): string {
  const args = explicitArgs.slice(1);
  return args.find(value => !value.startsWith("--")) ?? ".";
}

async function printCandidateSpecificManualFallback(
  requestedPath: string,
): Promise<void> {
  const root = path.resolve(requestedPath);
  const planPath = path.join(root, ".once", "protect-plan.json");

  let candidates: ProtectPlanCandidate[];
  try {
    const parsed = JSON.parse(
      (await fs.readFile(planPath, "utf8")).replace(/^\uFEFF/, ""),
    ) as { candidates?: unknown };
    if (!Array.isArray(parsed.candidates)) return;
    candidates = parsed.candidates as ProtectPlanCandidate[];
  } catch {
    return;
  }

  const allowedExtensions = new Set([
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
  ]);

  const reviewable = candidates.filter(candidate =>
    candidate.auto_apply_eligible === false &&
    typeof candidate.file === "string" &&
    typeof candidate.function_name === "string" &&
    candidate.function_name.length > 0 &&
    allowedExtensions.has(path.extname(candidate.file).toLowerCase())
  );

  const unique = new Map<string, ProtectPlanCandidate>();
  for (const candidate of reviewable) {
    const key = `${candidate.file}:${candidate.function_name}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }

  const selected = [...unique.values()].slice(0, 5);
  if (selected.length === 0) return;

  console.log("");
  console.log("REVIEW-ONLY protectLocal CANDIDATES");
  console.log("-----------------------------------");
  console.log(
    "These examples do not change the automatic result above. They are manual integration sketches for human review only."
  );
  console.log(
    "Once has not selected a business identity and has not declared any observed input list complete for effect binding."
  );

  for (const candidate of selected) {
    const file = candidate.file as string;
    const functionName = candidate.function_name as string;
    const sourcePath = path.resolve(root, file);
    const relative = path.relative(root, sourcePath);
    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      continue;
    }

    let fields: string[] = [];
    try {
      const stat = await fs.lstat(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      fields = observedDestructuredFields(
        await fs.readFile(sourcePath, "utf8"),
        functionName,
      );
    } catch {
      continue;
    }

    console.log("");
    console.log(`Candidate: ${file}:${functionName}`);
    console.log(
      `Observed classification: ${String(candidate.confidence ?? "UNKNOWN")} · ${String(candidate.category ?? "UNKNOWN")} · ${String(candidate.automation_status ?? "UNKNOWN")}`
    );
    if (fields.length > 0) {
      console.log(
        `Observed top-level destructured inputs: ${fields.join(", ")} (observation only; review identity and effect binding yourself).`
      );
    } else {
      console.log(
        "Input fields were not safely extracted. Review the function parameters manually before defining identity or payload."
      );
    }
    console.log("Review-only skeleton (intentionally non-runnable until TODOs are replaced):");
    console.log(`  const protectedAction = protectLocal(${functionName}, {`);
    console.log("    id: input => {");
    console.log(
      "      throw new Error(\"TODO: return one stable logical action id after human review\");"
    );
    console.log("    },");
    console.log("    payload: input => {");
    console.log(
      "      throw new Error(\"TODO: return every effect-bearing input after human review\");"
    );
    console.log("    },");
    console.log("  });");
  }

  console.log("");
  console.log("CONTROLLED VERIFICATION RECIPE");
  console.log("------------------------------");
  console.log("1. In a disposable environment, perform one intentional action and count the real effect.");
  console.log("2. Retry the same logical id with the same payload: expect replay and no second effect.");
  console.log("3. Reuse that id with a changed effect-bearing payload: expect CONFLICT and no dispatch.");
  console.log("4. If you can safely simulate response loss after commit, expect UNKNOWN; retries must not redispatch while truth is unavailable.");
  console.log("5. Reconcile only from authoritative read-only provider truth; a positive confirmation may recover the original result.");
  console.log("6. Keep the same durable local state and retry from a fresh process to verify persisted replay.");
  console.log(
    "Boundary: protectLocal is same-machine coordination. This recipe does not establish multi-host or universal exactly-once safety."
  );
  console.log(`Guide: ${LOCAL_FUNCTION_GUIDE}`);
}

type LocalBridgeDiagnosticTarget = Readonly<{
  file: string;
  functionName: string;
  sourcePath: string;
}>;

function diagnosticTarget(
  requestedPath: string,
  target: string,
): LocalBridgeDiagnosticTarget | undefined {
  const root = path.resolve(requestedPath);
  const separator = target.lastIndexOf(":");
  if (separator <= 0 || separator === target.length - 1) return undefined;

  const fileValue = target.slice(0, separator).trim();
  const functionName = target.slice(separator + 1).trim();
  if (!fileValue || path.isAbsolute(fileValue)) return undefined;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(functionName)) return undefined;

  const sourcePath = path.resolve(root, fileValue);
  const relative = path.relative(root, sourcePath);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }

  return {
    file: relative.replaceAll("\\", "/"),
    functionName,
    sourcePath,
  };
}

async function localBridgeRejectionDiagnostics(
  requestedPath: string,
  target: string,
): Promise<string[]> {
  const root = path.resolve(requestedPath);
  const parsed = diagnosticTarget(requestedPath, target);
  if (!parsed) return [];

  try {
    const stat = await fs.lstat(parsed.sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return [];

    const [realRoot, realSource] = await Promise.all([
      fs.realpath(root),
      fs.realpath(parsed.sourcePath),
    ]);
    const realRelative = path.relative(realRoot, realSource);
    if (
      realRelative === "" ||
      realRelative.startsWith("..") ||
      path.isAbsolute(realRelative)
    ) {
      return [];
    }

    const source = await fs.readFile(parsed.sourcePath, "utf8");
    const [scanModule, transformerModule] = await Promise.all([
      import("./scan.js"),
      import("./transformers/local-function-v1.js"),
    ]);
    const findings = await scanModule.scanFile(root, parsed.sourcePath);
    const categories = [
      ...new Set(findings.map(finding => finding.category)),
    ].sort();
    const bookingFindings = findings.filter(
      finding => finding.category === "BOOKING",
    );

    const lines: string[] = [];
    if (bookingFindings.length === 0) {
      if (categories.length > 0) {
        lines.push(
          `Scanner semantics: BOOKING/order was not established for this target. Observed consequential categories: ${categories.join(", ")}.`,
        );
      } else {
        lines.push(
          "Scanner semantics: no consequential BOOKING/order finding was established for this target.",
        );
      }
    }

    const namedLine =
      source
        .split(/\r?\n/)
        .findIndex(line => line.includes(parsed.functionName)) + 1;
    const diagnosticLines = [
      ...new Set([
        ...findings.map(finding => finding.line),
        ...(namedLine > 0 ? [namedLine] : []),
      ]),
    ].filter(line => Number.isSafeInteger(line) && line > 0);

    const shapeReasons = new Set<string>();
    let shapeCompatible = false;

    for (const findingLine of diagnosticLines) {
      const analysis = transformerModule.analyzeLocalFunctionV1({
        source,
        fileName: parsed.file,
        functionName: parsed.functionName,
        findingLine,
        // Diagnostic-only structural check. This never changes scanner category
        // or bridge eligibility; the real planner still requires BOOKING.
        category: "BOOKING",
      });

      if (analysis.eligible) {
        shapeCompatible = true;
        break;
      }

      if (
        analysis.reason !==
        "Scanner line does not resolve to the selected exported local function."
      ) {
        shapeReasons.add(analysis.reason);
      }
    }

    if (!shapeCompatible && shapeReasons.size > 0) {
      lines.push(`Source shape: ${[...shapeReasons][0]}`);
    } else if (shapeCompatible && bookingFindings.length === 0) {
      lines.push(
        "Source shape: compatible with local-function bridge v1, but scanner semantics are still outside BOOKING/order.",
      );
    }

    if (lines.length === 0) return [];

    lines.push("");
    lines.push("Safe supported fallback (no automatic rewrite):");
    lines.push(
      `  const protectedAction = protectLocal(${parsed.functionName}, { id: input => /* stable logical action id */, payload: input => ({ /* every effect-bearing input */ }) });`,
    );
    lines.push(
      "Review the logical identity and payload fields yourself. Once will not infer them for this rejected bridge attempt.",
    );
    lines.push(`Guide: ${LOCAL_FUNCTION_GUIDE}`);

    return lines;
  } catch {
    return [];
  }
}

async function runProtectLocal(): Promise<void> {
  const args = explicitArgs.slice(1);
  const allowed = args.every(
    value =>
      !value.startsWith("--") ||
      value === "--apply" ||
      value.startsWith("--target=") ||
      value.startsWith("--id-prefix=") ||
      value.startsWith("--id-field=")
  );

  if (!allowed) {
    throw new Error(
      "protect-local received an unsupported option. Supported options are --target=, --id-prefix=, --id-field= and --apply."
    );
  }

  const positionals = args.filter(value => !value.startsWith("--"));
  if (positionals.length > 1) {
    throw new Error("protect-local accepts at most one project directory.");
  }

  const requestedPath = positionals[0] ?? ".";
  const apply = args.includes("--apply");
  const target = optionValue(args, "target");
  const idPrefix = optionValue(args, "id-prefix");
  const idField = optionValue(args, "id-field");

  const {
    applyLocalFunctionBridgePlan,
    writeLocalFunctionBridgePlan,
  } = await import("./local-function-bridge.js");

  if (apply) {
    if (target !== undefined || idPrefix !== undefined || idField !== undefined) {
      throw new Error(
        "protect-local --apply uses the already-reviewed .once/local-function-protect-plan.json and does not accept target or identity options. Create/review the plan first, then run --apply."
      );
    }

    const result = await applyLocalFunctionBridgePlan(requestedPath);

    console.log("");
    console.log("Once Local Protection");
    console.log("=====================");
    console.log(`Applied: ${result.file}:${result.functionName}`);
    console.log(`Backup: ${result.backupPath}`);
    console.log(`Source SHA-256: ${result.sourceSha256}`);
    console.log(`Applied SHA-256: ${result.appliedSha256}`);
    console.log("ONCE LOCAL PROTECTION APPLIED");
    console.log(
      "Boundary: durable same-machine protectLocal state only. This is not a multi-host or universal exactly-once guarantee."
    );
    return;
  }

  if (target === undefined || idPrefix === undefined || idField === undefined) {
    throw new Error(
      "protect-local planning requires --target=<file:function>, --id-prefix=<prefix> and --id-field=<field>. Identity is never inferred."
    );
  }

  let plan;
  try {
    plan = await writeLocalFunctionBridgePlan(
      requestedPath,
      {
        target,
        idPrefix,
        idField,
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = await localBridgeRejectionDiagnostics(
      requestedPath,
      target,
    );

    if (diagnostics.length === 0) {
      throw error;
    }

    throw new Error([message, ...diagnostics].join("\n"));
  }

  const planPath = path.join(
    path.resolve(requestedPath),
    ".once",
    "local-function-protect-plan.json",
  );

  console.log("");
  console.log("Once Local Protection Plan");
  console.log("==========================");
  console.log(`Target: ${plan.target.file}:${plan.target.function_name}`);
  console.log(`Category: ${plan.target.category}`);
  console.log(`Identity prefix: ${JSON.stringify(plan.target.id_prefix)}`);
  console.log(`Identity field: ${plan.target.id_field}`);
  console.log(`Payload fields: ${plan.target.input_fields.join(", ")}`);
  console.log(`Plan: ${planPath}`);
  console.log("Source modified: no");
  console.log("");
  console.log("Review the plan and confirm that the chosen identity represents one intentional real-world action across retries.");
  console.log("Then apply explicitly with:");
  console.log(
    `  npx --yes --package=@once-agent/sdk once protect-local ${JSON.stringify(requestedPath)} --apply`
  );
}

if (command === "protect-local") {
  try {
    await runProtectLocal();
  } catch (error) {
    console.error("");
    console.error("Once protect-local failed.");
    console.error(
      error instanceof Error
        ? error.message
        : error
    );
    process.exitCode = 1;
  }
} else {
  if (zeroFriction) {
    process.argv.push(
      "doctor",
      ".",
      "--protect"
    );

    if (process.env.ONCE_API_KEY?.trim()) {
      process.argv.push(
        "--apply",
        "--verify"
      );
    }
  }

  await import("./cli.js");

  if (!process.exitCode) {
    const helpRequested =
      command === "help" ||
      command === "--help" ||
      command === "-h";

    if (helpRequested) {
      printLocalFunctionHelp();
    }

    const explicitDoctorProtect =
      command === "doctor" &&
      explicitArgs.includes("--protect");

    if (
      explicitDoctorProtect ||
      (zeroFriction && !process.env.ONCE_API_KEY?.trim())
    ) {
      printDoctorLocalBridgeGuidance();
      await printCandidateSpecificManualFallback(
        explicitDoctorProtect ? doctorRequestedPath() : ".",
      );
    }
  }

  if (zeroFriction && !process.exitCode) {
    const {
      measureAdoptionMetrics,
      printAdoptionMetrics
    } = await import("./adoption-metrics.js");

    const metrics = await measureAdoptionMetrics(
      ".",
      performance.now() - startedAt
    );

    printAdoptionMetrics(metrics);
  }
}

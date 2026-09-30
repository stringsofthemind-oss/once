#!/usr/bin/env node

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

  const plan = await writeLocalFunctionBridgePlan(
    requestedPath,
    {
      target,
      idPrefix,
      idField,
    }
  );

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

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  Once,
  OnceError
} from "./index.js";

import {
  collectSourceFiles,
  detectProjectMetadata,
  scanFile,
  type Finding
} from "./scan.js";

import {
  runProtect
} from "./protect.js";

import {
  applyProtectionPlan
} from "./apply.js";

import {
  discoverToolGraph,
  type ToolDiscoveryResult
} from "./tool-discovery.js";

import type {
  ToolActionBand
} from "./tool-importance.js";

import {
  writeAutoprotectPlan
} from "./autoprotect-plan.js";

export type DoctorOptions = {
  protect?: boolean;
  apply?: boolean;
  connection?: boolean;
};

const standaloneCli =
  "npx --yes --package=@once-agent/sdk once";

const actionBands: ToolActionBand[] = [
  "BYPASS",
  "OBSERVE",
  "REVIEW",
  "QUALIFY",
  "PROTECT_PRIORITY",
  "CRITICAL_GAP"
];

function confidenceRank(
  confidence: Finding["confidence"]
): number {
  switch (confidence) {
    case "HIGH":
      return 0;
    case "MEDIUM":
      return 1;
    default:
      return 2;
  }
}

function versionAtLeast(
  current: string,
  required: [number, number, number]
): boolean {
  const parts =
    current
      .split(".")
      .map(value => Number.parseInt(value, 10));

  const actual: [number, number, number] = [
    parts[0] ?? 0,
    parts[1] ?? 0,
    parts[2] ?? 0
  ];

  for (let index = 0; index < 3; index++) {
    if (actual[index] > required[index]) {
      return true;
    }

    if (actual[index] < required[index]) {
      return false;
    }
  }

  return true;
}

function printableTarget(
  requestedPath: string
): string {
  if (/^[A-Za-z0-9_./\\-]+$/.test(requestedPath)) {
    return requestedPath;
  }

  return JSON.stringify(requestedPath);
}

function printCandidate(
  finding: Finding,
  index: number
): void {
  const functionLabel =
    finding.functionName
      ? `${finding.functionName}()`
      : "operation";

  console.log(
    `${index + 1}. ${functionLabel}  ${finding.file}:${finding.line}`
  );
  console.log(
    `   ${finding.confidence} · ${finding.category}`
  );
  console.log(
    `   ${finding.reason}`
  );
}

async function printProtectionReadiness(
  requestedPath: string
): Promise<ToolDiscoveryResult> {
  const discovery =
    await discoverToolGraph(
      requestedPath
    );

  const counts =
    new Map<ToolActionBand, number>(
      actionBands.map(
        (band): [ToolActionBand, number] => [
          band,
          0
        ]
      )
    );

  for (const tool of discovery.tools) {
    const band =
      tool.once.actionPriority.band;

    counts.set(
      band,
      (counts.get(band) ?? 0) + 1
    );
  }

  const protectionGaps =
    (counts.get("PROTECT_PRIORITY") ?? 0) +
    (counts.get("CRITICAL_GAP") ?? 0);

  const unresolved =
    (counts.get("REVIEW") ?? 0) +
    (counts.get("QUALIFY") ?? 0);

  console.log("");
  console.log("PROTECTION READINESS");
  console.log("--------------------");
  console.log(
    `Tool/capability records: ${discovery.tools.length}`
  );
  console.log(
    `Configured tool sources: ${discovery.configuredSources.length}`
  );
  console.log(
    `BYPASS ${counts.get("BYPASS") ?? 0}   OBSERVE ${counts.get("OBSERVE") ?? 0}   REVIEW ${counts.get("REVIEW") ?? 0}`
  );
  console.log(
    `QUALIFY ${counts.get("QUALIFY") ?? 0}   PROTECT_PRIORITY ${counts.get("PROTECT_PRIORITY") ?? 0}   CRITICAL_GAP ${counts.get("CRITICAL_GAP") ?? 0}`
  );
  console.log("");

  if (protectionGaps > 0) {
    console.log(
      `! ${protectionGaps} high-priority execution-safety gap${protectionGaps === 1 ? "" : "s"} detected.`
    );
  } else {
    console.log(
      "✓ No high-priority execution-safety gaps were identified by the current local evidence."
    );
  }

  if (unresolved > 0) {
    console.log(
      `! ${unresolved} tool/capability record${unresolved === 1 ? "" : "s"} still require qualification or review.`
    );
  }

  console.log(
    "Discovery remained local/read-only: no tool was invoked, no configured stdio server was launched, and no provider was contacted."
  );

  return discovery;
}

async function runConnectionDoctor(): Promise<void> {
  console.log("");
  console.log("HOSTED CONNECTION");
  console.log("-----------------");

  if (!process.env.ONCE_API_KEY) {
    console.log("✗ ONCE_API_KEY is not set");
    console.log("");
    console.log(
      "Hosted connection verification needs ONCE_API_KEY. Local doctor scanning does not."
    );
    process.exitCode = 1;
    return;
  }

  console.log("✓ ONCE_API_KEY found");

  try {
    const once = new Once();
    const operationId =
      "doctor-" +
      randomUUID().replaceAll("-", "");

    const truth =
      await once.truth(operationId);

    console.log("✓ Once API reachable");
    console.log("✓ API key accepted");
    console.log("✓ Truth endpoint working");

    if (
      truth.ledger_state !== "ABSENT" ||
      truth.side_effects !== 0
    ) {
      console.log("✗ Unexpected doctor probe result");
      process.exitCode = 1;
      return;
    }

    console.log("✓ Safety probe passed");
  } catch (error) {
    if (error instanceof OnceError) {
      console.log(
        `✗ Once error: ${error.code ?? "unknown"}`
      );

      if (error.status) {
        console.log(`  HTTP ${error.status}`);
      }
    } else {
      console.log("✗ Unexpected connection error");
      console.error(error);
    }

    process.exitCode = 1;
  }
}

export async function runDoctor(
  requestedPath: string,
  options: DoctorOptions = {}
): Promise<void> {
  if (options.apply && !options.protect) {
    throw new Error(
      "Doctor --apply requires --protect so the review and automatic wiring plans are generated before the existing transactional apply engine is allowed to run."
    );
  }

  const root = path.resolve(requestedPath);
  const stat = await fs.stat(root);

  if (!stat.isDirectory()) {
    throw new Error(
      "Doctor target must be a directory."
    );
  }

  console.log("");
  console.log("Once Doctor");
  console.log("-----------");
  console.log(`Directory: ${root}`);
  console.log(
    `Mode: ${options.apply ? "local assessment + explicit transactional apply" : "local + read-only"}`
  );
  console.log("Source uploaded: no");
  console.log("API key required: no");

  const nodeVersion = process.versions.node;
  const cliReady =
    versionAtLeast(nodeVersion, [18, 0, 0]);
  const localReady =
    versionAtLeast(nodeVersion, [24, 15, 0]);

  console.log("");
  console.log("ENVIRONMENT");
  console.log("-----------");
  console.log(
    `${cliReady ? "✓" : "✗"} Node.js ${nodeVersion} ${cliReady ? "supports the Once CLI" : "is below the supported CLI minimum (18+)"}`
  );
  console.log(
    `${localReady ? "✓" : "!"} protectLocal ${localReady ? "runtime ready" : "needs Node.js 24.15+"}`
  );

  const metadata =
    await detectProjectMetadata(root);
  const files =
    await collectSourceFiles(root);
  const findings: Finding[] = [];

  for (const file of files) {
    findings.push(
      ...await scanFile(root, file)
    );
  }

  const sorted =
    [...findings].sort(
      (a, b) =>
        confidenceRank(a.confidence) -
          confidenceRank(b.confidence) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line
    );

  const high =
    findings.filter(
      finding => finding.confidence === "HIGH"
    ).length;
  const medium =
    findings.filter(
      finding => finding.confidence === "MEDIUM"
    ).length;
  const low =
    findings.filter(
      finding => finding.confidence === "LOW"
    ).length;

  console.log("");
  console.log("PROJECT");
  console.log("-------");
  console.log(`Files scanned: ${files.length}`);

  if (metadata.languages.length > 0) {
    console.log(
      `Languages: ${metadata.languages.join(", ")}`
    );
  }

  if (metadata.tooling.length > 0) {
    console.log(
      `Tooling: ${metadata.tooling.join(", ")}`
    );
  }

  console.log("");
  console.log("SAFETY FINDINGS");
  console.log("---------------");
  console.log(
    `Consequential-operation candidates: ${findings.length}`
  );
  console.log(
    `HIGH ${high}   MEDIUM ${medium}   LOW ${low}`
  );

  if (sorted.length === 0) {
    console.log("");
    console.log(
      "No obvious consequential operations were detected."
    );
    console.log(
      "This does not prove the project has no side effects."
    );
  } else {
    console.log("");

    for (
      const [index, finding]
      of sorted.slice(0, 8).entries()
    ) {
      printCandidate(finding, index);
    }

    if (sorted.length > 8) {
      console.log("");
      console.log(
        `... ${sorted.length - 8} additional candidates. Run ${standaloneCli} scan ${printableTarget(requestedPath)} --no-estimate for the full local scan.`
      );
    }
  }

  const discovery =
    await printProtectionReadiness(
      requestedPath
    );

  console.log("");
  console.log("NEXT STEP");
  console.log("---------");

  if (findings.length > 0) {
    console.log(
      "Review protection guidance without changing source code:"
    );
    console.log(
      `  ${standaloneCli} doctor ${printableTarget(requestedPath)} --protect`
    );
    console.log("");
    console.log(
      "Apply only if Once can prove exactly one supported PATCHABLE transformation:"
    );
    console.log(
      `  ${standaloneCli} doctor ${printableTarget(requestedPath)} --protect --apply`
    );
  } else {
    console.log(
      "If you know a consequential operation exists, review the full scanner output:"
    );
    console.log(
      `  ${standaloneCli} scan ${printableTarget(requestedPath)} --no-estimate`
    );
  }

  console.log("");
  console.log(
    options.apply
      ? "Source mutation was explicitly requested. The apply engine will still refuse zero, multiple, stale or unsupported PATCHABLE candidates."
      : "No source files were changed. Detection is heuristic; review candidates before applying protection."
  );

  if (options.protect) {
    console.log("");
    console.log("PROTECTION REVIEW");
    console.log("-----------------");
    console.log(
      options.apply
        ? "Generating review artifacts before attempting the existing transactional apply boundary."
        : "Generating .once/protect-plan.json, .once/autoprotect-plan.json and integration snippets. Source files will remain unchanged."
    );

    await runProtect(
      requestedPath,
      {
        includeAll: true,
        writePlan: true,
        writeSnippets: true
      }
    );

    await writeAutoprotectPlan(
      requestedPath,
      discovery
    );

    if (options.apply) {
      console.log("");
      console.log("SAFE APPLY");
      console.log("----------");

      const result =
        await applyProtectionPlan(
          requestedPath
        );

      console.log(
        `Applied: ${result.file}`
      );
      console.log(
        `Backup: ${result.backupPath}`
      );
      console.log(
        "Post-write TypeScript verification: PASS"
      );
      console.log(
        "ONE PROVEN PATCHABLE TRANSFORMATION APPLIED"
      );
      console.log(
        "This does not claim that every project tool or execution-safety gap is now protected."
      );
    }
  }

  if (options.connection) {
    await runConnectionDoctor();
  }
}

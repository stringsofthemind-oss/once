#!/usr/bin/env node

import { randomUUID } from "node:crypto";

import {
  Once,
  OnceError
} from "./index.js";

import {
  runScan
} from "./scan.js";

import {
  runSetup
} from "./setup.js";

import {
  runProtect
} from "./protect.js";

import {
  applyProtectionPlan
} from "./apply.js";

import {
  runBenchmark
} from "./benchmark.js";

async function runDoctor(): Promise<void> {

  console.log("");
  console.log("Once Doctor");
  console.log("-----------");

  if (!process.env.ONCE_API_KEY) {
    console.log(
      "✗ ONCE_API_KEY is not set"
    );

    console.log("");
    console.log(
      "Set ONCE_API_KEY and run again."
    );

    process.exitCode = 1;
    return;
  }

  console.log(
    "✓ ONCE_API_KEY found"
  );

  try {
    const once =
      new Once();

    const operationId =
      "doctor-" +
      randomUUID()
        .replaceAll("-", "");

    const truth =
      await once.truth(
        operationId
      );

    console.log(
      "✓ Once API reachable"
    );

    console.log(
      "✓ API key accepted"
    );

    console.log(
      "✓ Truth endpoint working"
    );

    if (
      truth.ledger_state !==
        "ABSENT" ||
      truth.side_effects !== 0
    ) {
      console.log(
        "✗ Unexpected doctor probe result"
      );

      process.exitCode = 1;
      return;
    }

    console.log(
      "✓ Safety probe passed"
    );

    console.log("");
    console.log(
      "Once is ready."
    );

  } catch (error) {

    if (
      error instanceof
      OnceError
    ) {
      console.log(
        `✗ Once error: ${error.code ?? "unknown"}`
      );

      if (error.status) {
        console.log(
          `  HTTP ${error.status}`
        );
      }

    } else {
      console.log(
        "✗ Unexpected error"
      );

      console.error(error);
    }

    process.exitCode = 1;
  }
}

function printHelp(): void {

  console.log("");
  console.log("Once");
  console.log("----");
  console.log("");
  console.log("Commands:");

  console.log(
    "  once protect [directory]"
  );

  console.log(
    "      Review candidate operations for Once protection."
  );

  console.log(
    "      Use --all to include all confidence levels."
  );

  console.log(
    "      Use --write-plan to save .once/protect-plan.json."
  );

  console.log(
    "      Use --patch to generate .once/protect-preview.diff."
  );

  console.log(
    "      Use --snippets to generate per-callsite integration guidance."
  );

  console.log(
    "      Use --apply to transactionally apply exactly one PATCHABLE candidate."
  );

  console.log("");

  console.log(
    "  once setup [directory] [--runtime-http=<target-url>]"
  );

  console.log(
    "      Detect, configure and install Once."
  );

  console.log(
    "      Use --plan to preview; --runtime-http=<https-url> enables Runtime HTTP replay protection."
  );

  console.log("");
  console.log(
    "  once scan [directory]"
  );

  console.log(
    "      Find likely consequential operations locally."
  );

  console.log("");
  console.log(
    "  once benchmark <trace.jsonl>"
  );

  console.log(
    "      Measure repeated-observation avoidance, change recall and EAR from an agent trace."
  );

  console.log("");
  console.log(
    "  once doctor"
  );

  console.log(
    "      Verify your Once connection."
  );

  console.log("");
  console.log("Examples:");

  console.log(
    "  once protect ."
  );

  console.log(
    "  once protect . --all --write-plan"
  );

  console.log(
    "  once protect . --all --patch"
  );

  console.log(
    "  once protect . --apply"
  );

  console.log(
    "  once setup ."
  );

  console.log(
    "  once scan ."
  );

  console.log(
    "  once benchmark .once/agent-trace.jsonl"
  );

  console.log(
    "  once doctor"
  );
}

async function main(): Promise<void> {

  const args =
    process.argv.slice(2);

  const command =
    (
      args.shift() ??
      "doctor"
    ).toLowerCase();

  switch (command) {

    case "doctor":
      await runDoctor();
      return;

    case "benchmark": {
      const tracePath =
        args.find(
          value =>
            !value.startsWith("--")
        );

      if (!tracePath) {
        throw new Error(
          "benchmark requires a JSONL trace path. Example: once benchmark .once/agent-trace.jsonl"
        );
      }

      await runBenchmark(tracePath);
      return;
    }

    case "scan": {
      const noEstimate =
        args.includes(
          "--no-estimate"
        );

      const requestedPath =
        args.find(
          value =>
            !value.startsWith("--")
        ) ?? ".";

      await runScan(
        requestedPath,
        !noEstimate
      );

      return;
    }

    case "protect": {
      const includeAll =
        args.includes(
          "--all"
        );

      const writePlan =
        args.includes(
          "--write-plan"
        );

      const writePatch =
        args.includes(
          "--patch"
        );

      const writeSnippets =
        args.includes(
          "--snippets"
        );

      const apply =
        args.includes(
          "--apply"
        );

      const requestedPath =
        args.find(
          value =>
            !value.startsWith("--")
        ) ?? ".";

      await runProtect(
        requestedPath,
        {
          includeAll:
            apply
              ? true
              : includeAll,

          writePlan:
            apply
              ? true
              : writePlan,

          writePatch,
          writeSnippets
        }
      );

      if (apply) {

        console.log("");
        console.log(
          "APPLYING PROTECTION"
        );

        console.log(
          "-------------------"
        );

        let result;

        try {

          result =
            await applyProtectionPlan(
              requestedPath
            );

        } catch (error) {

          const message =
            String(
              error instanceof Error
                ? error.message
                : error
            );

          /*
           * runProtect currently does not persist a plan
           * when zero candidates are selected.
           *
           * Because this apply path has just run Protect
           * successfully with writePlan=true, a missing
           * protect-plan here means there were zero
           * selected candidates.
           */
          if (
            message.includes(
              "protect-plan.json"
            ) &&
            message.includes(
              "ENOENT"
            )
          ) {
            throw new Error(
              "--apply requires exactly one PATCHABLE candidate; found 0."
            );
          }

          throw error;
        }

        console.log(
          `Applied: ${result.file}`
        );

        console.log(
          `Backup: ${result.backupPath}`
        );

        console.log(
          "TypeScript verification: PASS"
        );

        console.log(
          "ONCE PROTECTION APPLIED"
        );
      }

      return;
    }

    case "setup": {
      const autoConfirm =
        args.includes(
          "--yes"
        );

      const planOnly =
        args.includes(
          "--plan"
        );

      const skipInstall =
        args.includes(
          "--skip-install"
        );

      const runtimeHttpArgument =
        args.find(
          value =>
            value.startsWith(
              "--runtime-http="
            )
        );

      const runtimeHttp =
        args.includes(
          "--runtime-http"
        ) ||
        Boolean(
          runtimeHttpArgument
        );

      const runtimeHttpTargetUrl =
        runtimeHttpArgument
          ? runtimeHttpArgument
              .substring(
                "--runtime-http=".length
              )
              .trim()
          : undefined;

      const requestedPath =
        args.find(
          value =>
            !value.startsWith("--")
        ) ?? ".";

      await runSetup(
        requestedPath,
        {
          autoConfirm,
          planOnly,
          skipInstall,
          runtimeHttp,
          runtimeHttpTargetUrl
        }
      );

      return;
    }

    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    default:
      console.log(
        `Unknown command: ${command}`
      );

      printHelp();

      process.exitCode = 1;
  }
}

try {
  await main();

} catch (error) {

  console.error("");
  console.error(
    "Once command failed."
  );

  if (
    error instanceof Error
  ) {
    console.error(
      error.message
    );
  } else {
    console.error(error);
  }

  process.exitCode = 1;
}

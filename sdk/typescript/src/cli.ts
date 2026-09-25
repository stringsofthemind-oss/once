#!/usr/bin/env node

import {
  runDoctor
} from "./doctor.js";

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

import {
  runTraceFetch
} from "./trace.js";

import {
  discoverToolGraph
} from "./tool-discovery.js";

import {
  printToolDiscoveryReport
} from "./tool-report.js";

import {
  discoverLiveMcpTools
} from "./mcp-live-discovery.js";

import {
  printMcpLiveDiscoveryReport
} from "./mcp-live-report.js";

import {
  watchMcpToolListOnce
} from "./mcp-tool-refresh.js";

import {
  printMcpToolRefreshReport
} from "./mcp-tool-refresh-report.js";

function printHelp(): void {
  console.log("");
  console.log("Once");
  console.log("----");
  console.log("");
  console.log("Commands:");

  console.log(
    "  once doctor [directory] [--protect] [--connection] [--tools] [--tools-live=<host/name>] [--tools-watch-ms=<ms>]"
  );
  console.log(
    "      Run the low-friction local safety check. No API key required."
  );
  console.log(
    "      Use --protect to generate a review plan and snippets without changing source."
  );
  console.log(
    "      Use --connection to also verify the hosted Once API connection."
  );
  console.log(
    "      Use --tools to inventory local/configured tool surfaces and rank source-discovered capabilities."
  );
  console.log(
    "      Use --tools-live=<host/name> with --tools to explicitly enumerate one configured remote HTTP MCP server. Repeat to select more than one."
  );
  console.log(
    "      Use --tools-watch-ms=<50..60000> with exactly one --tools-live target to wait for one modern MCP tool-list change, refresh tools/list, report the diff, then exit."
  );
  console.log(
    "      Live tool enumeration/watch never launches configured stdio servers and does not follow redirects."
  );

  console.log("");
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
    "  once trace fetch <url> [--resource=<id>] [--trace=<path>]"
  );
  console.log(
    "      Record a raw HTTP observation for Dataset #1 without inventing an Once decision."
  );

  console.log("");
  console.log(
    "  once benchmark <trace.jsonl>"
  );
  console.log(
    "      Measure hindsight opportunity separately from measured Once avoidance."
  );

  console.log("");
  console.log("Examples:");
  console.log(
    "  once doctor ."
  );
  console.log(
    "  once doctor . --tools"
  );
  console.log(
    "  once doctor . --tools --tools-live=cursor/docs"
  );
  console.log(
    "  once doctor . --tools --tools-live=cursor/docs --tools-watch-ms=5000"
  );
  console.log(
    "  once doctor . --protect"
  );
  console.log(
    "  once doctor . --connection"
  );
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
    "  once trace fetch https://api.github.com/repos/stringsofthemind-oss/once"
  );
  console.log(
    "  once benchmark .once/agent-trace.jsonl"
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
    case "doctor": {
      const requestedPath =
        args.find(
          value =>
            !value.startsWith("--")
        ) ?? ".";

      const liveSelectors =
        args
          .filter(
            value =>
              value.startsWith("--tools-live=")
          )
          .map(
            value =>
              value.substring("--tools-live=".length).trim()
          )
          .filter(Boolean);

      const watchArgument =
        args.find(
          value =>
            value.startsWith("--tools-watch-ms=")
        );

      const watchMs =
        watchArgument
          ? Number(
              watchArgument.substring("--tools-watch-ms=".length)
            )
          : undefined;

      if (args.includes("--tools-live")) {
        throw new Error(
          "--tools-live requires an explicit configured server selector. Example: --tools-live=cursor/docs"
        );
      }

      if (args.includes("--tools-watch-ms")) {
        throw new Error(
          "--tools-watch-ms requires a bounded millisecond value. Example: --tools-watch-ms=5000"
        );
      }

      if (
        liveSelectors.length > 0 &&
        !args.includes("--tools")
      ) {
        throw new Error(
          "--tools-live must be used with --tools so the configured server inventory is reviewed before live enumeration."
        );
      }

      if (watchArgument && liveSelectors.length !== 1) {
        throw new Error(
          "--tools-watch-ms requires exactly one --tools-live=<host/name> target."
        );
      }

      if (watchArgument && !Number.isFinite(watchMs)) {
        throw new Error(
          "--tools-watch-ms must be a finite millisecond value."
        );
      }

      await runDoctor(
        requestedPath,
        {
          protect:
            args.includes("--protect"),
          connection:
            args.includes("--connection")
        }
      );

      if (args.includes("--tools")) {
        const discovery =
          await discoverToolGraph(
            requestedPath
          );

        printToolDiscoveryReport(
          discovery
        );

        if (liveSelectors.length > 0) {
          const live =
            await discoverLiveMcpTools(
              requestedPath,
              discovery.configuredSources,
              liveSelectors
            );

          printMcpLiveDiscoveryReport(live);

          if (watchArgument && watchMs !== undefined) {
            const refresh =
              await watchMcpToolListOnce(
                requestedPath,
                discovery.configuredSources,
                liveSelectors[0]!,
                live,
                { watchMs }
              );

            printMcpToolRefreshReport(refresh);
          }
        }
      }

      return;
    }

    case "trace": {
      const subcommand =
        (args.shift() ?? "").toLowerCase();

      if (subcommand !== "fetch") {
        throw new Error(
          "trace currently supports only read-only HTTP collection: once trace fetch <url>"
        );
      }

      const urlValue =
        args.find(
          value =>
            !value.startsWith("--")
        );

      if (!urlValue) {
        throw new Error(
          "trace fetch requires a URL. Example: once trace fetch https://api.github.com/repos/stringsofthemind-oss/once"
        );
      }

      const resourceArgument =
        args.find(
          value =>
            value.startsWith("--resource=")
        );

      const traceArgument =
        args.find(
          value =>
            value.startsWith("--trace=")
        );

      await runTraceFetch(
        urlValue,
        {
          resource:
            resourceArgument
              ? resourceArgument.substring("--resource=".length)
              : undefined,
          tracePath:
            traceArgument
              ? traceArgument.substring("--trace=".length)
              : undefined
        }
      );

      return;
    }

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

  if (error instanceof Error) {
    console.error(
      error.message
    );
  } else {
    console.error(error);
  }

  process.exitCode = 1;
}

#!/usr/bin/env node

import {
  printMonitorSnapshot
} from "./monitor-snapshot.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = (args.shift() ?? "snapshot").toLowerCase();

  switch (command) {
    case "snapshot": {
      const requestedPath =
        args.find(value => !value.startsWith("--")) ?? ".";

      if (args.some(value => value.startsWith("--"))) {
        throw new Error(
          "once-monitor snapshot does not accept network, live-probe, or payload flags."
        );
      }

      await printMonitorSnapshot(requestedPath);
      return;
    }

    case "help":
    case "--help":
    case "-h":
      process.stdout.write(
        "Once Monitor\n\n" +
        "  once-monitor snapshot [directory]\n" +
        "      Print one local, read-only, secret-minimal Monitor snapshot as JSON.\n"
      );
      return;

    default:
      throw new Error(`Unknown Once Monitor command: ${command}`);
  }
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  process.stderr.write(`Once Monitor command failed: ${message}\n`);
  process.exitCode = 1;
}

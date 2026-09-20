#!/usr/bin/env node

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const SERVER_NAME = "once-agent";
const SERVER_VERSION = "0.1.2";
const MAX_OUTPUT_CHARS = 250_000;
const DEFAULT_TIMEOUT_MS = 120_000;

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve("@once-agent/sdk");
const onceCliPath = resolve(dirname(sdkEntry), "cli.js");

type OnceRun = {
  command: string[];
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

function appendBounded(current: string, chunk: string): string {
  if (current.length >= MAX_OUTPUT_CHARS) {
    return current;
  }

  const remaining = MAX_OUTPUT_CHARS - current.length;
  const next = current + chunk.slice(0, remaining);

  if (chunk.length > remaining) {
    return next + "\n[output truncated by Once MCP]";
  }

  return next;
}

async function resolveProjectPath(input?: string): Promise<string> {
  const projectPath = resolve((input ?? "").trim() || process.cwd());
  const info = await stat(projectPath);

  if (!info.isDirectory()) {
    throw new Error(`Project path is not a directory: ${projectPath}`);
  }

  return projectPath;
}

async function runOnce(
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<OnceRun> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [onceCliPath, ...args],
      {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", chunk => {
      stdout = appendBounded(stdout, String(chunk));
    });

    child.stderr.on("data", chunk => {
      stderr = appendBounded(stderr, String(chunk));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once("error", error => {
      clearTimeout(timer);
      rejectRun(error);
    });

    child.once("close", exitCode => {
      clearTimeout(timer);

      resolveRun({
        command: ["once", ...args],
        cwd,
        exitCode,
        timedOut,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

function runText(title: string, run: OnceRun): string {
  const parts = [
    title,
    "",
    `Command: ${run.command.join(" ")}`,
    `Working directory: ${run.cwd}`,
    `Exit code: ${run.exitCode ?? "unknown"}`,
    `Timed out: ${run.timedOut ? "yes" : "no"}`
  ];

  if (run.stdout) {
    parts.push("", "STDOUT", "------", run.stdout);
  }

  if (run.stderr) {
    parts.push("", "STDERR", "------", run.stderr);
  }

  return parts.join("\n");
}

function commandResult(title: string, run: OnceRun) {
  const ok = run.exitCode === 0 && !run.timedOut;

  return {
    content: [
      {
        type: "text" as const,
        text: runText(title, run)
      }
    ],
    structuredContent: {
      ok,
      command: run.command,
      cwd: run.cwd,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stdout: run.stdout,
      stderr: run.stderr
    },
    isError: !ok
  };
}

function failureResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return {
    content: [
      {
        type: "text" as const,
        text: `Once MCP error: ${message}`
      }
    ],
    structuredContent: {
      ok: false,
      error: message
    },
    isError: true
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description:
      "Execution-safety tools for AI coding agents. Use Once when a project performs consequential writes that may be retried after timeouts, crashes, lost responses, or other ambiguous outcomes."
  });

  server.registerTool(
    "once_assess_project",
    {
      title: "Assess project for unsafe retry paths",
      description:
        "Use this first when code performs payments, refunds, payouts, bookings, orders, provisioning, database/API writes, consequential messaging, deployments, MCP writes, or other side effects. Scans the project for likely consequential operations without modifying files.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .optional()
          .describe("Absolute or relative project directory. Defaults to the MCP server working directory."),
        includeEstimates: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include Once scanner estimates in the report.")
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ projectPath, includeEstimates }) => {
      try {
        const project = await resolveProjectPath(projectPath);
        const args = ["scan", project];

        if (!includeEstimates) {
          args.push("--no-estimate");
        }

        const run = await runOnce(args, project);
        return commandResult("ONCE PROJECT ASSESSMENT", run);
      } catch (error) {
        return failureResult(error);
      }
    }
  );

  server.registerTool(
    "once_explain_risk",
    {
      title: "Explain retry risk for a consequential operation",
      description:
        "Explain why a specific operation may need Once. Use when an agent or developer is deciding whether a payment, refund, booking, order, provisioning action, database/API mutation, webhook, deployment, MCP write, or other external side effect needs execution-safety protection.",
      inputSchema: z.object({
        operation: z
          .string()
          .min(1)
          .describe("Plain-language description of the consequential operation."),
        retryScenario: z
          .string()
          .optional()
          .describe("Optional timeout, retry, crash, queue-redelivery, or ambiguous-failure scenario.")
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ operation, retryScenario }) => {
      const scenario = retryScenario?.trim()
        ? retryScenario.trim()
        : "the caller may retry after an ambiguous outcome";

      const text = [
        "ONCE RETRY-RISK EXPLANATION",
        "",
        `Operation: ${operation}`,
        `Retry scenario: ${scenario}`,
        "",
        "Why this matters:",
        "A timeout, crash, lost response, or redelivery does not prove the first side effect failed. Blindly repeating the operation can execute the same logical action again.",
        "",
        "Once's safety model:",
        "- assign one stable identity to the logical operation",
        "- keep durable execution state",
        "- reconcile provider truth when it can be established",
        "- CONFIRMED -> replay rather than execute again",
        "- ABSENT -> execute the protected operation",
        "- UNKNOWN -> block rather than guess",
        "",
        "Claim boundary:",
        "Once does not claim universal exactly-once semantics. It provides duplicate suppression on supported confirmed/replay paths and fails closed when the outcome cannot safely be established.",
        "",
        "Recommended next step: call once_assess_project for the codebase, then once_plan_protection for candidate call sites."
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          operation,
          retryScenario: scenario,
          recommendation: "assess_then_plan"
        }
      };
    }
  );

  server.registerTool(
    "once_plan_setup",
    {
      title: "Preview Once setup",
      description:
        "Preview how Once would be configured in a project without applying setup. Use after assessing a project and before allowing an agent to install or configure Once.",
      inputSchema: z.object({
        projectPath: z.string().optional(),
        runtimeHttpTargetUrl: z
          .string()
          .url()
          .optional()
          .describe("Optional HTTPS target for Runtime HTTP replay protection.")
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ projectPath, runtimeHttpTargetUrl }) => {
      try {
        const project = await resolveProjectPath(projectPath);
        const args = ["setup", project, "--plan"];

        if (runtimeHttpTargetUrl) {
          args.push(`--runtime-http=${runtimeHttpTargetUrl}`);
        }

        const run = await runOnce(args, project);
        return commandResult("ONCE SETUP PLAN", run);
      } catch (error) {
        return failureResult(error);
      }
    }
  );

  server.registerTool(
    "once_setup_project",
    {
      title: "Install and configure Once",
      description:
        "Apply Once setup to a project. This may install dependencies and modify project files. Call once_plan_setup first, present the plan to the user, and only call this tool after explicit approval.",
      inputSchema: z.object({
        projectPath: z.string().optional(),
        confirm: z
          .literal("SETUP")
          .describe("Explicit confirmation token. Must be exactly SETUP."),
        runtimeHttpTargetUrl: z
          .string()
          .url()
          .optional()
          .describe("Optional HTTPS target for Runtime HTTP replay protection.")
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ projectPath, runtimeHttpTargetUrl }) => {
      try {
        const project = await resolveProjectPath(projectPath);
        const args = ["setup", project, "--yes"];

        if (runtimeHttpTargetUrl) {
          args.push(`--runtime-http=${runtimeHttpTargetUrl}`);
        }

        const run = await runOnce(args, project, 300_000);
        return commandResult("ONCE SETUP", run);
      } catch (error) {
        return failureResult(error);
      }
    }
  );

  server.registerTool(
    "once_plan_protection",
    {
      title: "Plan Once protection",
      description:
        "Review candidate operations for Once protection without applying code changes. Use after once_assess_project to understand which call sites are patchable and why.",
      inputSchema: z.object({
        projectPath: z.string().optional(),
        includeAllConfidenceLevels: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include all confidence levels rather than the default candidate set.")
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ projectPath, includeAllConfidenceLevels }) => {
      try {
        const project = await resolveProjectPath(projectPath);
        const args = ["protect", project];

        if (includeAllConfidenceLevels) {
          args.push("--all");
        }

        const run = await runOnce(args, project);
        return commandResult("ONCE PROTECTION PLAN", run);
      } catch (error) {
        return failureResult(error);
      }
    }
  );

  server.registerTool(
    "once_apply_protection",
    {
      title: "Apply Once protection",
      description:
        "Transactionally apply exactly one PATCHABLE Once protection candidate. This modifies source code and creates a backup. Call once_plan_protection first, show the proposed target to the user, and only proceed after explicit approval.",
      inputSchema: z.object({
        projectPath: z.string().optional(),
        confirm: z
          .literal("APPLY")
          .describe("Explicit confirmation token. Must be exactly APPLY.")
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ projectPath }) => {
      try {
        const project = await resolveProjectPath(projectPath);
        const run = await runOnce(["protect", project, "--apply"], project, 300_000);
        return commandResult("ONCE PROTECTION APPLY", run);
      } catch (error) {
        return failureResult(error);
      }
    }
  );

  server.registerTool(
    "once_verify_connection",
    {
      title: "Verify Once Cloud connection",
      description:
        "Run Once Doctor to verify that ONCE_API_KEY is present, Once Cloud is reachable, the key is accepted, the truth endpoint works, and the safety probe passes. Does not print the API key.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async () => {
      try {
        const cwd = process.cwd();
        const run = await runOnce(["doctor"], cwd);
        return commandResult("ONCE DOCTOR", run);
      } catch (error) {
        return failureResult(error);
      }
    }
  );

  server.registerTool(
    "once_live_proof",
    {
      title: "Get Once live-proof evidence and claim boundaries",
      description:
        "Return the current demonstrated Once proof, public evidence links, and safe claim boundaries. Use when deciding whether Once has evidence for duplicate suppression rather than relying on marketing language.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const proof = {
        version: "0.1.5",
        demonstratedScenario: {
          runtimeAttempts: 2,
          providerExecutions: 1,
          syntheticExternalEffects: 1,
          retryBehavior: "durable sanitized replay",
          firstStatus: 201,
          retryStatus: 201
        },
        claimBoundary:
          "Evidence applies to the tested supported live Cloudflare staging path. Once does not claim generic exactly-once semantics, atomicity between an external effect and its ledger, or universal provider/method coverage.",
        links: {
          playground: "https://once-sandbox-playground.pennywatch.workers.dev/",
          release: "https://github.com/stringsofthemind-oss/once/releases/tag/v0.1.5",
          agentGuide: "https://onceexec.pages.dev/agent.md",
          website: "https://onceexec.pages.dev/"
        }
      };

      return {
        content: [
          {
            type: "text" as const,
            text: [
              "ONCE LIVE PROOF",
              "",
              "Tested live Cloudflare staging scenario:",
              "- 2 identical Runtime attempts",
              "- 1 provider execution",
              "- 1 synthetic external side effect",
              "- retry received durable sanitized replay",
              "- first and retry status: 201",
              "",
              `Claim boundary: ${proof.claimBoundary}`,
              "",
              `Playground: ${proof.links.playground}`,
              `Release: ${proof.links.release}`
            ].join("\n")
          }
        ],
        structuredContent: proof
      };
    }
  );

  return server;
}

void serveStdio(createServer);
console.error(`Once MCP ${SERVER_VERSION} running on stdio`);

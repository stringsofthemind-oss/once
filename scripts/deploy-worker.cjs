#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline/promises");

const REPOSITORY = "stringsofthemind-oss/once";

const repoRoot =
  path.resolve(__dirname, "..");

const targets = Object.freeze({
  runtime: {
    workerName: "once-q18-cloud",
    packageName: "once-q18-cloud",
    directory: path.join(
      repoRoot,
      "workers",
      "runtime"
    )
  },

  playground: {
    workerName: "once-sandbox-playground",
    packageName: "once-sandbox-playground",
    directory: path.join(
      repoRoot,
      "workers",
      "playground"
    )
  },

  "demo-provider": {
    workerName: "once-sandbox-demo-provider",
    packageName: "once-sandbox-demo-provider",
    directory: path.join(
      repoRoot,
      "workers",
      "demo-provider"
    )
  }
});

function fail(message, exitCode = 1) {
  console.error("");
  console.error(`[ONCE DEPLOY GUARD] ${message}`);
  process.exit(exitCode);
}

function run(
  command,
  args,
  {
    cwd = repoRoot,
    stdio = "inherit",
    encoding
  } = {}
) {
  const result =
    spawnSync(
      command,
      args,
      {
        cwd,
        stdio,
        encoding,
        windowsHide: true,
        shell: false,
        env: process.env
      }
    );

  if (result.error) {
    throw result.error;
  }

  return result;
}

function gitText(args) {
  const result =
    run(
      "git",
      args,
      {
        cwd: repoRoot,
        stdio: "pipe",
        encoding: "utf8"
      }
    );

  if (result.status !== 0) {
    fail(
      `git ${args.join(" ")} failed.`
    );
  }

  return String(
    result.stdout || ""
  ).trim();
}

function readNamedArgument(name) {
  const args =
    process.argv.slice(4);

  const exactPrefix =
    `${name}=`;

  for (
    let index = 0;
    index < args.length;
    index++
  ) {
    const value =
      args[index];

    if (
      value.startsWith(
        exactPrefix
      )
    ) {
      return value.slice(
        exactPrefix.length
      );
    }

    if (
      value === name &&
      index + 1 < args.length
    ) {
      return args[index + 1];
    }
  }

  return "";
}

function envTruthy(name) {
  const value =
    String(
      process.env[name] || ""
    )
      .trim()
      .toLowerCase();

  return (
    value !== "" &&
    value !== "0" &&
    value !== "false" &&
    value !== "no"
  );
}

function validateWorker(target) {
  const packagePath =
    path.join(
      target.directory,
      "package.json"
    );

  const wranglerPath =
    path.join(
      target.directory,
      "wrangler.jsonc"
    );

  if (
    !fs.existsSync(packagePath) ||
    !fs.existsSync(wranglerPath)
  ) {
    fail(
      "Expected Worker package/configuration files are missing."
    );
  }

  const packageJson =
    JSON.parse(
      fs.readFileSync(
        packagePath,
        "utf8"
      )
    );

  if (
    packageJson.name !==
    target.packageName
  ) {
    fail(
      `Package identity mismatch. Expected ${target.packageName}.`
    );
  }

  const wranglerText =
    fs.readFileSync(
      wranglerPath,
      "utf8"
    );

  const nameMatch =
    wranglerText.match(
      /"name"\s*:\s*"([^"]+)"/
    );

  if (
    !nameMatch ||
    nameMatch[1] !==
      target.workerName
  ) {
    fail(
      `Wrangler identity mismatch. Expected ${target.workerName}.`
    );
  }

  const mainMatch =
    wranglerText.match(
      /"main"\s*:\s*"([^"]+)"/
    );

  if (
    !mainMatch ||
    mainMatch[1] !==
      "src/index.js"
  ) {
    fail(
      "Wrangler entrypoint is not the expected src/index.js."
    );
  }
}

function localWrangler(target) {
  const wranglerPackagePath =
    path.join(
      target.directory,
      "node_modules",
      "wrangler",
      "package.json"
    );

  if (
    !fs.existsSync(
      wranglerPackagePath
    )
  ) {
    fail(
      "Local Wrangler is not installed. Run npm ci in the Worker directory first. The guard will not download Wrangler implicitly."
    );
  }

  const metadata =
    JSON.parse(
      fs.readFileSync(
        wranglerPackagePath,
        "utf8"
      )
    );

  let binRelative = "";

  if (
    typeof metadata.bin ===
      "string"
  ) {
    binRelative =
      metadata.bin;
  }
  else if (
    metadata.bin &&
    typeof metadata.bin.wrangler ===
      "string"
  ) {
    binRelative =
      metadata.bin.wrangler;
  }

  if (!binRelative) {
    fail(
      "Installed Wrangler package does not expose a wrangler CLI."
    );
  }

  const cliPath =
    path.resolve(
      path.dirname(
        wranglerPackagePath
      ),
      binRelative
    );

  if (
    !fs.existsSync(cliPath)
  ) {
    fail(
      "Local Wrangler CLI entrypoint is missing."
    );
  }

  return {
    cliPath,
    version:
      String(
        metadata.version || "unknown"
      )
  };
}

function runWrangler(
  target,
  args
) {
  const local =
    localWrangler(target);

  console.log(
    `[ONCE DEPLOY GUARD] Using local Wrangler ${local.version}`
  );

  const result =
    run(
      process.execPath,
      [
        local.cliPath,
        ...args
      ],
      {
        cwd:
          target.directory,
        stdio:
          "inherit"
      }
    );

  if (
    result.status !== 0
  ) {
    fail(
      `Wrangler exited with code ${result.status}.`
    );
  }
}

function validateRepository() {
  const resolvedRoot =
    path.resolve(
      gitText([
        "rev-parse",
        "--show-toplevel"
      ])
    );

  if (
    resolvedRoot.toLowerCase() !==
    repoRoot.toLowerCase()
  ) {
    fail(
      "Guard is not running inside the expected Once repository root."
    );
  }

  const remote =
    gitText([
      "remote",
      "get-url",
      "origin"
    ]);

  const normalized =
    remote
      .replace(
        /^git@github\.com:/i,
        "https://github.com/"
      )
      .replace(
        /^ssh:\/\/git@github\.com\//i,
        "https://github.com/"
      )
      .replace(
        /\.git$/i,
        ""
      )
      .replace(
        /\/+$/,
        ""
      );

  const expected =
    `https://github.com/${REPOSITORY}`;

  if (
    normalized.toLowerCase() !==
    expected.toLowerCase()
  ) {
    fail(
      `origin is not ${REPOSITORY}.`
    );
  }
}

function validateProductionGitState() {
  validateRepository();

  const branch =
    gitText([
      "branch",
      "--show-current"
    ]);

  if (
    branch !== "main"
  ) {
    fail(
      "Production deployment is allowed only from main."
    );
  }

  const dirty =
    gitText([
      "status",
      "--porcelain"
    ]);

  if (dirty) {
    fail(
      "Production deployment requires a completely clean Git worktree."
    );
  }

  console.log(
    "[ONCE DEPLOY GUARD] Fetching origin before production verification..."
  );

  const fetchResult =
    run(
      "git",
      [
        "fetch",
        "origin"
      ],
      {
        cwd:
          repoRoot,
        stdio:
          "inherit"
      }
    );

  if (
    fetchResult.status !== 0
  ) {
    fail(
      "git fetch origin failed."
    );
  }

  const head =
    gitText([
      "rev-parse",
      "HEAD"
    ]);

  const originMain =
    gitText([
      "rev-parse",
      "origin/main"
    ]);

  if (
    head !== originMain
  ) {
    fail(
      "Local main does not exactly match origin/main."
    );
  }

  return head;
}

async function productionDeploy(
  target
) {
  if (
    envTruthy("CI")
  ) {
    fail(
      "Production Worker deployment is forbidden from CI."
    );
  }

  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    fail(
      "Production Worker deployment requires an interactive terminal."
    );
  }

  const suppliedConfirmation =
    readNamedArgument(
      "--confirm"
    );

  if (
    suppliedConfirmation !==
    target.workerName
  ) {
    fail(
      `Missing exact confirmation. Use --confirm=${target.workerName}`
    );
  }

  validateWorker(target);

  const head =
    validateProductionGitState();

  console.log("");
  console.log(
    `[ONCE DEPLOY GUARD] Git HEAD verified: ${head}`
  );

  console.log("");
  console.log(
    "[ONCE DEPLOY GUARD] Running mandatory Wrangler dry-run first..."
  );

  runWrangler(
    target,
    [
      "deploy",
      "--dry-run"
    ]
  );

  const dirtyAfterDryRun =
    gitText([
      "status",
      "--porcelain"
    ]);

  if (
    dirtyAfterDryRun
  ) {
    fail(
      "Worktree changed during dry-run. Refusing production deployment."
    );
  }

  const branchAfterDryRun =
    gitText([
      "branch",
      "--show-current"
    ]);

  const headAfterDryRun =
    gitText([
      "rev-parse",
      "HEAD"
    ]);

  const originAfterDryRun =
    gitText([
      "rev-parse",
      "origin/main"
    ]);

  if (
    branchAfterDryRun !==
      "main" ||
    headAfterDryRun !==
      head ||
    originAfterDryRun !==
      head
  ) {
    fail(
      "Git state changed during deployment checks."
    );
  }

  const requiredPhrase =
    `DEPLOY ${target.workerName}`;

  console.log("");
  console.log(
    "============================================================"
  );
  console.log(
    `PRODUCTION WORKER: ${target.workerName}`
  );
  console.log(
    `GIT COMMIT:        ${head}`
  );
  console.log(
    "============================================================"
  );
  console.log("");
  console.log(
    "No production upload has occurred."
  );
  console.log(
    "This is the final deployment gate."
  );
  console.log("");

  const rl =
    readline.createInterface({
      input:
        process.stdin,
      output:
        process.stdout
    });

  let answer = "";

  try {
    answer =
      await rl.question(
        `Type "${requiredPhrase}" to continue: `
      );
  }
  finally {
    rl.close();
  }

  if (
    answer.trim() !==
    requiredPhrase
  ) {
    fail(
      "Final deployment confirmation did not match. Nothing deployed."
    );
  }

  console.log("");
  console.log(
    "[ONCE DEPLOY GUARD] Refreshing origin after final confirmation..."
  );

  const finalFetchResult =
    run(
      "git",
      [
        "fetch",
        "origin"
      ],
      {
        cwd:
          repoRoot,
        stdio:
          "inherit"
      }
    );

  if (
    finalFetchResult.status !== 0
  ) {
    fail(
      "Final git fetch origin failed. Nothing deployed."
    );
  }

  const branchBeforeDeploy =
    gitText([
      "branch",
      "--show-current"
    ]);

  const dirtyBeforeDeploy =
    gitText([
      "status",
      "--porcelain"
    ]);

  const headBeforeDeploy =
    gitText([
      "rev-parse",
      "HEAD"
    ]);

  const originBeforeDeploy =
    gitText([
      "rev-parse",
      "origin/main"
    ]);

  if (
    branchBeforeDeploy !==
      "main" ||
    dirtyBeforeDeploy ||
    headBeforeDeploy !==
      head ||
    originBeforeDeploy !==
      head
  ) {
    fail(
      "Git state changed before final deployment. Nothing deployed."
    );
  }

  console.log("");
  console.log(
    `[ONCE DEPLOY GUARD] Final gate passed for ${target.workerName}.`
  );
  console.log(
    "[ONCE DEPLOY GUARD] Starting Wrangler production deployment..."
  );
  console.log("");

  runWrangler(
    target,
    [
      "deploy"
    ]
  );
}

async function main() {
  const [
    targetKey,
    mode
  ] =
    process.argv.slice(2);

  const target =
    targets[targetKey];

  if (!target) {
    fail(
      "Unknown Worker target."
    );
  }

  if (
    mode === "refuse"
  ) {
    console.error("");
    console.error(
      `[ONCE DEPLOY GUARD] Direct deployment of ${target.workerName} is intentionally disabled.`
    );
    console.error("");
    console.error(
      "Safe commands:"
    );
    console.error(
      "  npm run deploy:dry-run"
    );
    console.error(
      `  npm run deploy:production -- --confirm=${target.workerName}`
    );
    console.error("");
    console.error(
      "Production mode has additional Git, CI, dry-run and interactive confirmation gates."
    );
    process.exit(1);
  }

  if (
    mode === "dry-run"
  ) {
    validateWorker(target);

    console.log(
      `[ONCE DEPLOY GUARD] Safe dry-run for ${target.workerName}`
    );

    runWrangler(
      target,
      [
        "deploy",
        "--dry-run"
      ]
    );

    console.log("");
    console.log(
      "[ONCE DEPLOY GUARD] Dry-run complete. Nothing deployed."
    );

    return;
  }

  if (
    mode === "production"
  ) {
    await productionDeploy(
      target
    );

    return;
  }

  fail(
    "Unknown deployment mode."
  );
}

main().catch(
  error => {
    console.error("");
    console.error(
      "[ONCE DEPLOY GUARD] Unexpected failure:"
    );
    console.error(
      error instanceof Error
        ? error.message
        : String(error)
    );
    process.exit(1);
  }
);
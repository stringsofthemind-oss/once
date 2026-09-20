import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import {
  stdin as input,
  stdout as output
} from "node:process";

import {
  collectSourceFiles,
  detectProjectMetadata,
  runScan,
  scanFile
} from "./scan.js";

type SetupOptions = {
  autoConfirm?: boolean;
  planOnly?: boolean;
  skipInstall?: boolean;
  runtimeHttp?: boolean;
  runtimeHttpTargetUrl?: string;
};

type ProviderRegistration = {
  name: string;
  version_id: string;
  created?: boolean;
  rotated?: boolean;
};

const DEFAULT_BASE =
  "https://once-q18-cloud.pennywatch.workers.dev";

async function exists(
  filePath: string
): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(
  root: string
): Promise<string> {

  const candidates:
    Array<[string, string]> = [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lockb", "bun"],
      ["bun.lock", "bun"],
      ["package-lock.json", "npm"],
      ["uv.lock", "uv"],
      ["poetry.lock", "poetry"]
    ];

  for (const [file, manager] of candidates) {
    if (
      await exists(
        path.join(root, file)
      )
    ) {
      return manager;
    }
  }

  if (
    await exists(
      path.join(root, "package.json")
    )
  ) {
    return "npm";
  }

  if (
    await exists(
      path.join(root, "requirements.txt")
    )
  ) {
    return "pip";
  }

  if (
    await exists(
      path.join(root, "pyproject.toml")
    )
  ) {
    return "pip";
  }

  return "not detected";
}

async function detectOnceInstallation(
  root: string
): Promise<boolean> {

  try {
    const raw =
      await fs.readFile(
        path.join(root, "package.json"),
        "utf8"
      );

    const pkg =
      JSON.parse(
        raw.replace(/^\uFEFF/, "")
      ) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

    if (
      pkg.name === "@once-agent/sdk"
    ) {
      return true;
    }

    const dependencies = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {})
    };

    if (
      "@once-agent/sdk" in dependencies
    ) {
      return true;
    }

  } catch {
    // Node metadata optional.
  }

  for (
    const file of [
      "requirements.txt",
      "pyproject.toml"
    ]
  ) {
    try {
      const raw =
        (
          await fs.readFile(
            path.join(root, file),
            "utf8"
          )
        ).toLowerCase();

      if (
        raw.includes(
          "once-agent-sdk"
        )
      ) {
        return true;
      }

    } catch {
      // Python metadata optional.
    }
  }

  return false;
}

function commandName(
  command: string
): string {

  if (
    process.platform === "win32" &&
    ["npm", "pnpm", "yarn"].includes(command)
  ) {
    return `${command}.cmd`;
  }

  return command;
}

function installCommand(
  manager: string
): {
  command: string;
  args: string[];
  display: string;
} | undefined {

  const nodePackage =
    process.env.ONCE_SETUP_NODE_PACKAGE ||
    "@once-agent/sdk";

  const pythonPackage =
    process.env.ONCE_SETUP_PYTHON_PACKAGE ||
    "once-agent-sdk";

  switch (manager) {
    case "npm":
      return {
        command: commandName("npm"),
        args: ["install", nodePackage],
        display: `npm install ${nodePackage}`
      };

    case "pnpm":
      return {
        command: commandName("pnpm"),
        args: ["add", nodePackage],
        display: `pnpm add ${nodePackage}`
      };

    case "yarn":
      return {
        command: commandName("yarn"),
        args: ["add", nodePackage],
        display: `yarn add ${nodePackage}`
      };

    case "bun":
      return {
        command: "bun",
        args: ["add", nodePackage],
        display: `bun add ${nodePackage}`
      };

    case "uv":
      return {
        command: "uv",
        args: ["add", pythonPackage],
        display: `uv add ${pythonPackage}`
      };

    case "poetry":
      return {
        command: "poetry",
        args: ["add", pythonPackage],
        display: `poetry add ${pythonPackage}`
      };

    case "pip":
      return {
        command: "python",
        args: [
          "-m",
          "pip",
          "install",
          pythonPackage
        ],
        display:
          `python -m pip install ${pythonPackage}`
      };

    default:
      return undefined;
  }
}

function runInstall(
  root: string,
  manager: string
): void {

  const installation =
    installCommand(manager);

  if (!installation) {
    throw new Error(
      "Could not determine an automatic SDK install command."
    );
  }

  console.log("");
  console.log(
    `Installing: ${installation.display}`
  );

  const result =
    process.platform === "win32"
      ? spawnSync(
          process.env.ComSpec ||
            "cmd.exe",
          [
            "/d",
            "/c",
            installation.command,
            ...installation.args
          ],
          {
            cwd: root,
            stdio: "inherit"
          }
        )
      : spawnSync(
          installation.command,
          installation.args,
          {
            cwd: root,
            stdio: "inherit"
          }
        );

  if (result.error) {
    throw new Error(
      "Once SDK installation failed to start: " +
      result.error.message
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `Once SDK installation failed with exit code ${result.status}.`
    );
  }

  console.log(
    "SDK installation complete."
  );
}

async function askSecret(
  promptText: string
): Promise<string> {

  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    return "";
  }

  return await new Promise<string>(
    (resolve, reject) => {

      const stdin =
        process.stdin;

      let value = "";

      let onData:
        (
          chunk: string | Buffer
        ) => void;

      const cleanup =
        () => {

          stdin.off(
            "data",
            onData
          );

          if (stdin.isTTY) {
            stdin.setRawMode(false);
          }

          output.write("\n");
        };

      onData =
        (
          chunk: string | Buffer
        ) => {

          const chars =
            String(chunk);

          for (
            const char of chars
          ) {

            if (char === "\u0003") {
              cleanup();

              reject(
                new Error(
                  "Setup cancelled."
                )
              );

              return;
            }

            if (
              char === "\r" ||
              char === "\n"
            ) {
              cleanup();
              resolve(
                value.trim()
              );
              return;
            }

            if (
              char === "\u007f" ||
              char === "\b"
            ) {
              if (
                value.length > 0
              ) {
                value =
                  value.slice(
                    0,
                    -1
                  );

                output.write(
                  "\b \b"
                );
              }

              continue;
            }

            value += char;
            output.write("*");
          }
        };

      output.write(promptText);

      stdin.setEncoding("utf8");
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    }
  );
}

const DEFAULT_ACTIVATION_BASE =
  "https://once-sandbox-playground.pennywatch.workers.dev";


function openExternalUrl(
  url: string
): boolean {

  try {

    let result;

    if (
      process.platform === "win32"
    ) {

      const safeUrl =
        url.replace(
          /"/g,
          '""'
        );

      result =
        spawnSync(
          "cmd.exe",
          [
            "/d",
            "/s",
            "/c",
            `start "" "${safeUrl}"`
          ],
          {
            stdio: "ignore",
            windowsHide: true
          }
        );
    }
    else if (
      process.platform === "darwin"
    ) {

      result =
        spawnSync(
          "open",
          [
            url
          ],
          {
            stdio: "ignore"
          }
        );
    }
    else {

      result =
        spawnSync(
          "xdg-open",
          [
            url
          ],
          {
            stdio: "ignore"
          }
        );
    }


    return (
      !result.error &&
      result.status === 0
    );
  }
  catch {
    return false;
  }
}


async function readJsonBody(
  response: Response
): Promise<any> {

  const text =
    await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  }
  catch {
    return {
      message: text
    };
  }
}


export async function acquireApiKeyThroughActivation(
  rl: readline.Interface
): Promise<string> {

  const activationBase =
    String(
      process.env.ONCE_ACTIVATION_BASE_URL ||
      DEFAULT_ACTIVATION_BASE
    )
      .trim()
      .replace(/\/+$/, "");


  const configuredPlan =
    String(
      process.env.ONCE_SETUP_PLAN ||
      ""
    ).trim();


  let plan =
    configuredPlan;


  if (!plan) {

    const answer =
      String(
        await rl.question(
          "Once plan [startup]: "
        )
      ).trim();

    plan =
      answer ||
      "startup";
  }


  console.log("");
  console.log(
    "Starting Once activation..."
  );


  let checkoutResponse:
    Response;

  try {

    checkoutResponse =
      await fetch(
        `${activationBase}/api/checkout`,
        {
          method: "POST",

          headers: {
            "content-type":
              "application/json"
          },

          body:
            JSON.stringify({
              plan
            })
        }
      );
  }
  catch (error) {

    throw new Error(
      "Could not reach the Once activation service.",
      {
        cause:
          error
      }
    );
  }


  const checkout =
    await readJsonBody(
      checkoutResponse
    );


  if (
    !checkoutResponse.ok
  ) {

    throw new Error(
      checkout?.message ||
      checkout?.error ||
      `Once activation checkout failed (HTTP ${checkoutResponse.status}).`
    );
  }


  const checkoutUrl =
    String(
      checkout?.url ||
      ""
    ).trim();


  const sessionId =
    String(
      checkout?.session_id ||
      ""
    ).trim();


  if (
    !checkoutUrl ||
    !sessionId
  ) {

    throw new Error(
      "Once activation returned an incomplete checkout response."
    );
  }


  /*
   * /api/claim requires the signed sandbox session
   * cookie created by /api/checkout.
   *
   * Keep it only in memory for this setup process.
   */

  const setCookie =
    checkoutResponse.headers.get(
      "set-cookie"
    );


  const claimCookie =
    String(
      setCookie ||
      ""
    )
      .split(";")[0]
      .trim();


  if (!claimCookie) {

    throw new Error(
      "Once activation did not return the required secure session cookie."
    );
  }


  console.log("");
  console.log(
    "Opening secure checkout in your browser..."
  );


  const opened =
    process.env.ONCE_SETUP_NO_BROWSER === "1"
      ? false
      : openExternalUrl(
          checkoutUrl
        );


  if (!opened) {

    console.log("");
    console.log(
      "Open this checkout URL in your browser:"
    );

    console.log(
      checkoutUrl
    );
  }


  console.log("");
  console.log(
    "Complete checkout in the browser."
  );


  await rl.question(
    "When checkout is complete, press Enter to continue..."
  );


  console.log("");
  console.log(
    "Claiming Once credentials..."
  );


  let claimResponse:
    Response;

  try {

    claimResponse =
      await fetch(
        `${activationBase}/api/claim`,
        {
          method:
            "POST",

          headers: {
            "content-type":
              "application/json",

            cookie:
              claimCookie
          },

          body:
            JSON.stringify({
              session_id:
                sessionId
            })
        }
      );
  }
  catch (error) {

    /*
     * Do NOT automatically retry claim.
     *
     * Credential issuance may have occurred even if the
     * response was lost.
     */

    throw new Error(
      "Credential claim outcome is uncertain. Once will not retry issuance automatically.",
      {
        cause:
          error
      }
    );
  }


  const claim =
    await readJsonBody(
      claimResponse
    );


  if (
    !claimResponse.ok
  ) {

    if (
      claim?.status ===
        "AMBIGUOUS" ||
      claim?.error ===
        "api_key_issue_ambiguous"
    ) {

      throw new Error(
        "Credential issuance is ambiguous. Once will not issue or claim another key automatically."
      );
    }


    throw new Error(
      claim?.message ||
      claim?.error ||
      `Once credential claim failed (HTTP ${claimResponse.status}).`
    );
  }


  const apiKey =
    String(
      claim?.api_key ||
      ""
    ).trim();


  if (!apiKey) {

    if (
      claim?.already_claimed
    ) {

      throw new Error(
        "This activation was already claimed and its raw API key cannot be recovered. Use the original key."
      );
    }


    throw new Error(
      "Once activation completed without returning an API key."
    );
  }


  console.log("");
  console.log(
    "Once activated."
  );

  console.log(
    "API key received securely."
  );


  if (claim?.plan) {

    console.log(
      `Plan: ${claim.plan}`
    );
  }


  if (
    claim?.monthly_limit != null
  ) {

    console.log(
      `Monthly limit: ${claim.monthly_limit}`
    );
  }


  /*
   * Deliberately do NOT print apiKey.
   */

  return apiKey;
}


async function verifyApiKey(
  baseUrl: string,
  apiKey: string
): Promise<void> {

  const operationId =
    "setup-doctor-" +
    randomUUID()
      .replaceAll("-", "");

  const response =
    await fetch(
      `${baseUrl}/v1/truth/${encodeURIComponent(operationId)}`,
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${apiKey}`
        }
      }
    );

  let body:
    Record<string, unknown> = {};

  try {
    body =
      await response.json() as
        Record<string, unknown>;
  } catch {
    // handled below
  }

  if (!response.ok) {
    throw new Error(
      `Once API verification failed (HTTP ${response.status}).`
    );
  }

  if (
    body.ledger_state !==
      "ABSENT" ||
    Number(
      body.side_effects
    ) !== 0
  ) {
    throw new Error(
      "Once Doctor returned an unexpected safety-probe result."
    );
  }
}

async function registerProvider(
  baseUrl: string,
  apiKey: string,
  name: string,
  providerUrl: string,
  token: string,
  runtimeHttpTargetUrl?: string
): Promise<ProviderRegistration> {

  const response =
    await fetch(
      `${baseUrl}/v1/providers`,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${apiKey}`,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          name,
          type: "http_v1",
          base_url:
            providerUrl,
          token,
          ...(
            runtimeHttpTargetUrl
              ? {
                  response_replay:
                    "required",
                  allowed_urls: [
                    runtimeHttpTargetUrl
                  ]
                }
              : {}
          )
        })
      }
    );

  let body:
    Record<string, unknown> = {};

  try {
    body =
      await response.json() as
        Record<string, unknown>;
  } catch {
    // handled below
  }

  if (!response.ok) {
    const error =
      typeof body.error ===
      "string"
        ? body.error
        : "provider_registration_failed";

    throw new Error(
      `Provider registration failed: ${error} (HTTP ${response.status}).`
    );
  }

  const versionId =
    String(
      body.version_id || ""
    );

  if (!versionId) {
    throw new Error(
      "Provider registration did not return a version ID."
    );
  }

  if (
    runtimeHttpTargetUrl &&
    body.response_replay !==
      "required"
  ) {
    throw new Error(
      "Provider registration did not confirm required HTTP response replay capability."
    );
  }

  return {
    name,
    version_id:
      versionId,
    created:
      Boolean(body.created),
    rotated:
      Boolean(body.rotated)
  };
}

async function persistApiKey(
  root: string,
  apiKey: string
): Promise<void> {

  const envPath =
    path.join(
      root,
      ".env"
    );

  let envText = "";

  try {
    envText =
      await fs.readFile(
        envPath,
        "utf8"
      );
  } catch {
    // new file
  }

  if (
    !/^ONCE_API_KEY=/m.test(
      envText
    )
  ) {
    const separator =
      envText.length > 0 &&
      !envText.endsWith("\n")
        ? "\n"
        : "";

    envText +=
      separator +
      `ONCE_API_KEY=${apiKey}\n`;

    await fs.writeFile(
      envPath,
      envText,
      "utf8"
    );

    try {
      await fs.chmod(
        envPath,
        0o600
      );
    } catch {
      // Best effort on platforms such as Windows.
    }
  }

  const ignorePath =
    path.join(
      root,
      ".gitignore"
    );

  let ignoreText = "";

  try {
    ignoreText =
      await fs.readFile(
        ignorePath,
        "utf8"
      );
  } catch {
    // new file
  }

  const ignored =
    ignoreText
      .split(/\r?\n/)
      .map(
        value =>
          value.trim()
      )
      .includes(".env");

  if (!ignored) {
    const separator =
      ignoreText.length > 0 &&
      !ignoreText.endsWith("\n")
        ? "\n"
        : "";

    await fs.writeFile(
      ignorePath,
      ignoreText +
        separator +
        ".env\n",
      "utf8"
    );
  }
}

async function writeOnceConfig(
  root: string,
  baseUrl: string,
  providerName: string,
  providerUrl: string,
  versionId: string,
  runtimeHttpTargetUrl?: string
): Promise<void> {

  const onceDirectory =
    path.join(
      root,
      ".once"
    );

  await fs.mkdir(
    onceDirectory,
    {
      recursive: true
    }
  );

  const config = {
    version: 1,
    api_base: baseUrl,
    provider: {
      name: providerName,
      type: "http_v1",
      base_url: providerUrl,
      version_id: versionId,
      ...(
        runtimeHttpTargetUrl
          ? {
              response_replay:
                "required",
              allowed_urls: [
                runtimeHttpTargetUrl
              ]
            }
          : {}
      )
    }
  };

  await fs.writeFile(
    path.join(
      onceDirectory,
      "config.json"
    ),
    JSON.stringify(
      config,
      null,
      2
    ) + "\n",
    "utf8"
  );
}

function printQuickstart(
  providerName: string,
  runtimeHttpTargetUrl?: string
): void {
  if (runtimeHttpTargetUrl) {
    console.log("");
    console.log(
      "YOUR FIRST RUNTIME-PROTECTED FETCH"
    );
    console.log(
      "----------------------------------"
    );
    console.log("");
    console.log(
      "Save this as app.mjs:"
    );
    console.log("");
    console.log(
      'import { createOnceRuntimeFetch } from "@once-agent/sdk";'
    );
    console.log("");
    console.log(
      "const onceFetch = createOnceRuntimeFetch({"
    );
    console.log(
      `  provider: ${JSON.stringify(providerName)}`
    );
    console.log(
      "});"
    );
    console.log("");
    console.log(
      "async function main() {"
    );
    console.log(
      `  const response = await onceFetch(${JSON.stringify(runtimeHttpTargetUrl)}, {`
    );
    console.log(
      '    method: "POST",'
    );
    console.log(
      "    headers: {"
    );
    console.log(
      '      "content-type": "application/json",'
    );
    console.log(
      '      "idempotency-key": "your-stable-business-id"'
    );
    console.log(
      "    },"
    );
    console.log(
      "    body: JSON.stringify({"
    );
    console.log(
      "      example: true"
    );
    console.log(
      "    })"
    );
    console.log(
      "  });"
    );
    console.log("");
    console.log(
      "  console.log(response.status);"
    );
    console.log(
      "  console.log(await response.text());"
    );
    console.log(
      "}"
    );
    console.log("");
    console.log(
      "main().catch(console.error);"
    );
    console.log("");
    console.log(
      "For vanilla Node with the .env created by setup:"
    );
    console.log(
      "  node --env-file=.env app.mjs"
    );
    console.log("");
    console.log(
      "Rule: retry the same real-world action with the same idempotency key."
    );
    return;
  }


  console.log("");
  console.log(
    "YOUR FIRST PROTECTED CALL"
  );
  console.log(
    "-------------------------"
  );
  console.log("");
  console.log(
    "Save this as app.mjs:"
  );
  console.log("");
  console.log(
    'import { Once } from "@once-agent/sdk";'
  );
  console.log("");
  console.log(
    "async function main() {"
  );
  console.log(
    "  const once = new Once();"
  );
  console.log("");
  console.log(
    "  const operationId = Once.id("
  );
  console.log(
    '    "your-action",'
  );
  console.log(
    '    "your-stable-business-id"'
  );
  console.log(
    "  );"
  );
  console.log("");
  console.log(
    "  const result = await once.execute({"
  );
  console.log(
    "    operationId,"
  );
  console.log(
    `    provider: "${providerName}",`
  );
  console.log(
    "    action: {"
  );
  console.log(
    '      type: "YOUR_ACTION"'
  );
  console.log(
    "    }"
  );
  console.log(
    "  });"
  );
  console.log("");
  console.log(
    "  console.log(result.state);"
  );
  console.log(
    "}"
  );
  console.log("");
  console.log(
    "main().catch(console.error);"
  );
  console.log("");
  console.log(
    "For vanilla Node with the .env created by setup:"
  );
  console.log(
    "  node --env-file=.env app.mjs"
  );
  console.log("");
  console.log(
    "Rule: retry the same real-world action with the same operation ID."
  );
}

export async function runSetup(
  requestedPath: string,
  options: SetupOptions = {}
): Promise<void> {

  const root =
    path.resolve(
      requestedPath
    );

  const stat =
    await fs.stat(root);

  if (!stat.isDirectory()) {
    throw new Error(
      "Setup target must be a directory."
    );
  }

  const metadata =
    await detectProjectMetadata(
      root
    );

  const packageManager =
    await detectPackageManager(
      root
    );

  const onceInstalled =
    await detectOnceInstallation(
      root
    );

  const files =
    await collectSourceFiles(
      root
    );

  const findings = [];

  for (const file of files) {
    findings.push(
      ...await scanFile(
        root,
        file
      )
    );
  }

  const high =
    findings.filter(
      finding =>
        finding.confidence ===
        "HIGH"
    ).length;

  const medium =
    findings.filter(
      finding =>
        finding.confidence ===
        "MEDIUM"
    ).length;

  const low =
    findings.filter(
      finding =>
        finding.confidence ===
        "LOW"
    ).length;

  const installation =
    installCommand(
      packageManager
    );

  console.log("");
  console.log("Once Setup");
  console.log("==========");

  console.log("");
  console.log(
    `Project: ${root}`
  );

  console.log("");
  console.log("DETECTED");
  console.log("--------");

  console.log(
    `Languages: ${
      metadata.languages.length
        ? metadata.languages.join(", ")
        : "not detected"
    }`
  );

  console.log(
    `Package manager: ${packageManager}`
  );

  console.log(
    `AI/framework tooling: ${
      metadata.tooling.length
        ? metadata.tooling.join(", ")
        : "none detected"
    }`
  );

  console.log(
    `Once SDK installed: ${
      onceInstalled
        ? "yes"
        : "no"
    }`
  );

  console.log(
    `Source files scanned: ${files.length}`
  );

  console.log("");
  console.log(
    `Consequential-operation candidates: ${findings.length}`
  );

  console.log(
    `HIGH ${high}   MEDIUM ${medium}   LOW ${low}`
  );

  console.log("");
  console.log("SETUP PLAN");
  console.log("----------");

  if (
    !onceInstalled &&
    installation
  ) {
    console.log(
      `1. Install SDK: ${installation.display}`
    );
  } else if (onceInstalled) {
    console.log(
      "1. Keep existing Once SDK."
    );
  } else {
    console.log(
      "1. SDK installation requires manual selection."
    );
  }

  console.log(
    "2. Activate Once or verify an existing Once API key."
  );

  console.log(
    "   If ONCE_API_KEY is not set, setup can open secure activation or accept an existing key."
  );

  console.log(
    "3. Save ONCE_API_KEY to .env and ensure .env is gitignored. Your runtime must load .env before new Once() can use it."
  );

  console.log(
    "4. Register one provider: the external HTTPS API that performs the real-world side effect."
  );

  console.log(
    "   Setup will ask for a provider name, HTTPS base URL, and bearer token."
  );

  console.log(
    "5. Store only non-secret provider metadata in .once/config.json; the provider bearer token is not written there."
  );

  console.log(
    "6. Run a final Once Doctor safety probe."
  );

  console.log(
    `7. Review ${findings.length} protection candidate${
      findings.length === 1
        ? ""
        : "s"
    }.`
  );

  console.log("");
  console.log(
    "Application source code will NOT be modified."
  );

  if (options.planOnly) {
    console.log("");
    console.log(
      "PLAN ONLY: no files changed and no network setup performed."
    );
    return;
  }

  let rl:
    readline.Interface | undefined;

  if (
    process.stdin.isTTY &&
    process.stdout.isTTY
  ) {
    rl =
      readline.createInterface({
        input,
        output
      });
  }

  try {
    if (
      !options.autoConfirm
    ) {
      if (!rl) {
        throw new Error(
          "Interactive confirmation unavailable. Run with --yes."
        );
      }

      const answer =
        (
          await rl.question(
            "Apply this setup? [Y/n] "
          )
        )
          .trim()
          .toLowerCase();

      if (
        answer === "n" ||
        answer === "no"
      ) {
        console.log(
          "Setup cancelled."
        );
        return;
      }
    }

    let apiKey =
      String(
        process.env.ONCE_API_KEY ||
        ""
      ).trim();

    if (!apiKey) {

      if (!rl) {

        if (
          process.stdin.isTTY &&
          process.stdout.isTTY
        ) {

          rl =
            readline.createInterface({
              input,
              output
            });
        }
      }


      if (!rl) {

        throw new Error(
          "No Once API key found. Run once setup in an interactive terminal, or set ONCE_API_KEY."
        );
      }


      console.log("");
      console.log(
        "ONCE ACTIVATION"
      );

      console.log(
        "---------------"
      );

      console.log(
        "No ONCE_API_KEY was found."
      );

      console.log("");
      console.log(
        "1. Activate Once and get a new API key"
      );

      console.log(
        "2. I already have a Once API key"
      );

      console.log("");


      const credentialChoice =
        String(
          await rl.question(
            "Choose [1]: "
          )
        )
          .trim()
          .toLowerCase();


      if (
        credentialChoice === "" ||
        credentialChoice === "1" ||
        credentialChoice === "activate" ||
        credentialChoice === "new"
      ) {

        apiKey =
          await acquireApiKeyThroughActivation(
            rl
          );
      }
      else if (
        credentialChoice === "2" ||
        credentialChoice === "existing" ||
        credentialChoice === "key"
      ) {

        rl.close();
        rl = undefined;


        apiKey =
          await askSecret(
            "Once API key: "
          );
      }
      else {

        throw new Error(
          "Invalid activation choice. Choose 1 or 2."
        );
      }
    }


    if (!apiKey) {

      throw new Error(
        "ONCE_API_KEY is required."
      );
    }

    const baseUrl =
      String(
        process.env.ONCE_BASE_URL ||
        DEFAULT_BASE
      )
        .trim()
        .replace(/\/+$/, "");

    console.log("");
    console.log(
      "Verifying Once API..."
    );

    await verifyApiKey(
      baseUrl,
      apiKey
    );

    console.log(
      "API key verified."
    );

    if (
      !onceInstalled &&
      !options.skipInstall
    ) {
      runInstall(
        root,
        packageManager
      );
    }

    await persistApiKey(
      root,
      apiKey
    );

    console.log(
      "ONCE_API_KEY saved to .env."
    );

    console.log(
      "Note: vanilla Node does not automatically load .env."
    );

    console.log(
      "Load .env with your framework/runtime, or on supported Node versions run with: node --env-file=.env <your-entry-file>"
    );

    console.log(
      ".env is listed in .gitignore."
    );

    if (!rl) {
      if (
        process.stdin.isTTY &&
        process.stdout.isTTY
      ) {
        rl =
          readline.createInterface({
            input,
            output
          });
      }
    }

    console.log("");
    console.log("PROVIDER SETUP");
    console.log("--------------");
    console.log(
      "A provider is the external HTTPS API that performs the consequential action."
    );
    console.log(
      "Setup will ask for a local name, its HTTPS base URL, and a bearer token."
    );
    console.log(
      "The bearer token is used during provider registration and is not written to .once/config.json."
    );
    console.log("");

    const providerName =
      String(
        process.env.ONCE_SETUP_PROVIDER_NAME ||
        (
          rl
            ? await rl.question(
                "Provider name [my-api]: "
              )
            : ""
        ) ||
        "my-api"
      )
        .trim()
        .toLowerCase();

    const providerUrl =
      String(
        process.env.ONCE_SETUP_PROVIDER_URL ||
        (
          rl
            ? await rl.question(
                "Provider HTTPS base URL: "
              )
            : ""
        )
      ).trim();

    if (!providerUrl) {
      throw new Error(
        "Provider base URL is required."
      );
    }

    let runtimeHttpTargetUrl =
      "";


    if (options.runtimeHttp) {
      runtimeHttpTargetUrl =
        String(
          options.runtimeHttpTargetUrl ||
          process.env.ONCE_SETUP_RUNTIME_TARGET_URL ||
          (
            rl
              ? await rl.question(
                  "Protected target HTTPS URL: "
                )
              : ""
          )
        ).trim();


      if (!runtimeHttpTargetUrl) {
        throw new Error(
          "Runtime HTTP setup requires an exact protected target URL. Use --runtime-http=<https-url> or ONCE_SETUP_RUNTIME_TARGET_URL."
        );
      }


      let parsedRuntimeTarget:
        URL;

      try {
        parsedRuntimeTarget =
          new URL(
            runtimeHttpTargetUrl
          );
      }
      catch {
        throw new Error(
          "Runtime HTTP target URL is invalid."
        );
      }


      if (
        parsedRuntimeTarget.protocol !==
          "https:"
      ) {
        throw new Error(
          "Runtime HTTP target URL must use HTTPS."
        );
      }


      if (
        parsedRuntimeTarget.username ||
        parsedRuntimeTarget.password ||
        parsedRuntimeTarget.hash
      ) {
        throw new Error(
          "Runtime HTTP target URL cannot contain credentials or a fragment."
        );
      }


      parsedRuntimeTarget.searchParams.sort();

      runtimeHttpTargetUrl =
        parsedRuntimeTarget
          .toString();

      console.log("");
      console.log(
        `Runtime HTTP replay target: ${runtimeHttpTargetUrl}`
      );
    }


    let providerToken =
      String(
        process.env.ONCE_SETUP_PROVIDER_TOKEN ||
        ""
      ).trim();

    if (!providerToken) {
      if (rl) {
        rl.close();
        rl = undefined;
      }

      providerToken =
        await askSecret(
          "Provider bearer token: "
        );
    }

    if (!providerToken) {
      throw new Error(
        "Provider bearer token is required."
      );
    }

    console.log("");
    console.log(
      `Registering provider "${providerName}"...`
    );

    const provider =
      await registerProvider(
        baseUrl,
        apiKey,
        providerName,
        providerUrl,
        providerToken,
        runtimeHttpTargetUrl || undefined
      );

    providerToken = "";

    console.log(
      `Provider registered: ${provider.version_id}`
    );

    await writeOnceConfig(
      root,
      baseUrl,
      providerName,
      providerUrl,
      provider.version_id,
      runtimeHttpTargetUrl || undefined
    );

    console.log(
      "Non-secret Once config written to .once/config.json."
    );

    await verifyApiKey(
      baseUrl,
      apiKey
    );

    console.log(
      "Final Once Doctor probe passed."
    );

    console.log("");
    console.log(
      "ONCE SETUP COMPLETE"
    );

    console.log(
      "No application source files were changed."
    );

    printQuickstart(
      providerName,
      runtimeHttpTargetUrl || undefined
    );

    if (
      findings.length > 0
    ) {
      console.log("");
      console.log(
        `${findings.length} protection candidates are ready for review.`
      );

      console.log(
        "Run: once scan ."
      );
    }

  } finally {
    rl?.close();
  }
}

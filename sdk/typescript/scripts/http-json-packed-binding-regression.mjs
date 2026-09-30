import assert from "node:assert/strict";

import {
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";

import {
  existsSync
} from "node:fs";

import {
  spawnSync
} from "node:child_process";

import os from "node:os";
import path from "node:path";

import {
  buildHttpJsonPatchV1
} from "../dist/transformers/http-json-patch-plan-v1.js";

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const unique = `${process.pid}-${Date.now()}`;
const packDirectory = path.join(os.tmpdir(), `once-http-json-pack-${unique}`);
const sandbox = path.join(os.tmpdir(), `once-http-json-consumer-${unique}`);

function run(command, args, options = {}) {
  const isWindowsNpm =
    process.platform === "win32" &&
    command.toLowerCase() === "npm.cmd";

  const executable =
    isWindowsNpm
      ? (process.env.ComSpec || "cmd.exe")
      : command;

  const executableArgs =
    isWindowsNpm
      ? ["/d", "/c", "npm.cmd", ...args]
      : args;

  return spawnSync(
    executable,
    executableArgs,
    {
      encoding: "utf8",
      ...options
    }
  );
}

async function writeJson(file, value) {
  await writeFile(
    file,
    JSON.stringify(value, null, 2) + "\n",
    "utf8"
  );
}

const provider = "customer-http";
const targetUrl = "https://api.example.invalid/orders";
const capability = {
  name: provider,
  version_id: "provider-version-1",
  response_replay: "required",
  allowed_urls: [targetUrl]
};

const statement = `const result =
  await (
    await fetch(
      "https://api.example.invalid/orders",
      {
        method: "POST",
        body: JSON.stringify(payload)
      }
    )
  ).json();`;

const source = `export async function createOrder(operationId, payload) {
  ${statement}
  return result;
}
`;

const functionSource = `export async function createOrder(operationId, payload) {
}
`;

await rm(packDirectory, { recursive: true, force: true });
await rm(sandbox, { recursive: true, force: true });
await mkdir(packDirectory, { recursive: true });
await mkdir(sandbox, { recursive: true });

try {
  const patch = buildHttpJsonPatchV1({
    source,
    statement,
    functionSource,
    provider,
    capability
  });

  assert.equal(
    patch.eligible,
    true,
    "known-safe response-consuming source must produce a patch"
  );

  if (!patch.eligible) {
    throw new Error(patch.reason);
  }

  assert.match(
    patch.proposedSource,
    /@once-agent\/sdk\/http-response-json/
  );

  const packed = run(
    npm,
    [
      "pack",
      "--json",
      "--pack-destination",
      packDirectory
    ],
    { cwd: root }
  );

  if (packed.status !== 0) {
    console.error(packed.stdout);
    console.error(packed.stderr);
    throw new Error("npm pack failed");
  }

  const packInfo = JSON.parse(packed.stdout);

  assert.equal(
    Array.isArray(packInfo) && packInfo.length === 1,
    true,
    "npm pack must return exactly one artifact"
  );

  const tarball = path.join(
    packDirectory,
    packInfo[0].filename
  );

  assert.equal(
    existsSync(tarball),
    true,
    "packed SDK tarball must exist"
  );

  await writeJson(
    path.join(sandbox, "package.json"),
    {
      name: "once-http-json-packed-consumer",
      version: "1.0.0",
      private: true,
      type: "module"
    }
  );

  const installed = run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball
    ],
    { cwd: sandbox }
  );

  if (installed.status !== 0) {
    console.error(installed.stdout);
    console.error(installed.stderr);
    throw new Error("packed SDK install failed");
  }

  const appPath = path.join(sandbox, "app.mjs");

  await writeFile(
    appPath,
    patch.proposedSource,
    "utf8"
  );

  const syntax = run(
    node,
    ["--check", appPath],
    { cwd: sandbox }
  );

  if (syntax.status !== 0) {
    console.error(syntax.stdout);
    console.error(syntax.stderr);
    throw new Error("generated consumer source failed node --check");
  }

  const imported = run(
    node,
    [
      "--input-type=module",
      "-e",
      [
        'const mod = await import("./app.mjs");',
        'if (typeof mod.createOrder !== "function") process.exit(2);'
      ].join("\n")
    ],
    { cwd: sandbox }
  );

  if (imported.status !== 0) {
    console.error(imported.stdout);
    console.error(imported.stderr);
    throw new Error("generated consumer source failed to resolve packed helper import");
  }

  const installedPackage = JSON.parse(
    await readFile(
      path.join(
        sandbox,
        "node_modules",
        "@once-agent",
        "sdk",
        "package.json"
      ),
      "utf8"
    )
  );

  assert.equal(
    installedPackage.exports?.["./http-response-json"]?.import,
    "./dist/http-response-json.js",
    "packed SDK must expose the helper subpath"
  );

  console.log("PASS - fresh publishable SDK tarball created");
  console.log("PASS - packed SDK installs in an isolated consumer project");
  console.log("PASS - generated patched source passes node --check");
  console.log("PASS - generated source resolves @once-agent/sdk/http-response-json from packed SDK");
  console.log("PASS - generated module imports without executing the consequential action");
} finally {
  await rm(packDirectory, { recursive: true, force: true });
  await rm(sandbox, { recursive: true, force: true });
}

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

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const unique = `${process.pid}-${Date.now()}`;
const packDirectory = path.join(os.tmpdir(), `once-http-response-pack-${unique}`);
const sandbox = path.join(os.tmpdir(), `once-http-response-consumer-${unique}`);

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

await rm(packDirectory, { recursive: true, force: true });
await rm(sandbox, { recursive: true, force: true });
await mkdir(packDirectory, { recursive: true });
await mkdir(sandbox, { recursive: true });

try {
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
      name: "once-http-response-packed-consumer",
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

  const installedPackagePath = path.join(
    sandbox,
    "node_modules",
    "@once-agent",
    "sdk",
    "package.json"
  );

  const installedPackage = JSON.parse(
    await readFile(
      installedPackagePath,
      "utf8"
    )
  );

  const responseExport =
    installedPackage.exports?.["./http-response"];

  assert.equal(
    responseExport?.import,
    "./dist/http-response.js",
    "packed SDK must expose the ESM native Response helper"
  );

  assert.equal(
    responseExport?.require,
    "./dist-cjs/http-response.js",
    "packed SDK must expose the CJS native Response helper"
  );

  assert.equal(
    existsSync(
      path.join(
        path.dirname(installedPackagePath),
        responseExport.types
      )
    ),
    true,
    "packed SDK must include native Response helper declarations"
  );

  const appSource = `
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { executeHttpWriteResponse } from "@once-agent/sdk/http-response";

const targetBody = JSON.stringify({ created: true, id: "external-1" });
const targetBytes = Buffer.from(targetBody, "utf8");

const replayV2 = {
  contract: "http_response_replay_v2",
  status: 201,
  status_text: "Created For Once",
  headers_entries: [
    ["content-type", "application/json; charset=utf-8"],
    ["x-once-test", "native-response"]
  ],
  body_present: true,
  body_base64: targetBytes.toString("base64"),
  body_length: targetBytes.byteLength,
  url: "https://api.example.invalid/orders/1",
  redirected: true,
  type: "default"
};

let mode = "v2";
let executeCalls = 0;

const fetchImpl = async (input, init) => {
  executeCalls++;
  assert.match(String(input), /\\/v1\\/execute$/);

  const requestBody = JSON.parse(String(init?.body));
  assert.equal(requestBody.operation_id, "order:1");
  assert.equal(requestBody.action.type, "http_write_v1");

  const httpResponse = {
    status: 201,
    body_text: targetBody,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-once-test": "native-response"
    },
    recorded_at: "2026-09-30T18:30:00.000Z"
  };

  if (mode === "v2") {
    httpResponse.replay_v2 = replayV2;
  }

  if (mode === "invalid") {
    httpResponse.replay_v2 = {
      ...replayV2,
      hidden_extra_field: true
    };
  }

  return new Response(
    JSON.stringify({
      operation_id: "order:1",
      result: "executed",
      state: "CONFIRMED",
      http_response: httpResponse
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    }
  );
};

const options = {
  apiKey: "test-key",
  baseUrl: "https://once.example.invalid",
  networkRetries: 0,
  fetchImpl
};

const input = {
  operationId: "order:1",
  provider: "customer-http",
  action: {
    type: "http_write_v1",
    method: "POST",
    url: "https://api.example.invalid/orders",
    body_json: JSON.stringify({ item: "book" })
  }
};

const response = await executeHttpWriteResponse(input, options);

assert.equal(response instanceof Response, true);
assert.equal(Object.prototype.toString.call(response), "[object Response]");
assert.equal(response.status, 201);
assert.equal(response.statusText, "Created For Once");
assert.equal(response.ok, true);
assert.equal(response.url, replayV2.url);
assert.equal(response.redirected, true);
assert.equal(response.type, "default");
assert.equal(response.headers.get("x-once-test"), "native-response");
assert.equal(response.bodyUsed, false);

assert.throws(
  () => response.headers.set("x-forbidden", "1"),
  TypeError
);

const clone = response.clone();
assert.deepEqual(await clone.json(), { created: true, id: "external-1" });
assert.equal(clone.bodyUsed, true);
assert.equal(response.bodyUsed, false);
assert.equal(await response.text(), targetBody);
assert.equal(response.bodyUsed, true);
assert.throws(() => response.clone(), TypeError);

mode = "legacy";
await assert.rejects(
  () => executeHttpWriteResponse(input, options),
  error => error?.code === "runtime_http_response_v2_missing"
);

mode = "invalid";
await assert.rejects(
  () => executeHttpWriteResponse(input, options),
  error => error?.code === "runtime_http_response_v2_invalid"
);

assert.equal(executeCalls, 3);
console.log("PACKED NATIVE RESPONSE PASS");
`;

  await writeFile(
    path.join(sandbox, "app.mjs"),
    appSource.trimStart(),
    "utf8"
  );

  const esm = run(
    node,
    ["app.mjs"],
    { cwd: sandbox }
  );

  if (esm.status !== 0) {
    console.error(esm.stdout);
    console.error(esm.stderr);
    throw new Error("packed native Response ESM consumer failed");
  }

  assert.match(
    esm.stdout,
    /PACKED NATIVE RESPONSE PASS/
  );

  const cjs = run(
    node,
    [
      "-e",
      [
        'const m = require("@once-agent/sdk/http-response");',
        'if (typeof m.executeHttpWriteResponse !== "function") process.exit(2);',
        'console.log("CJS NATIVE RESPONSE PASS");'
      ].join("\n")
    ],
    { cwd: sandbox }
  );

  if (cjs.status !== 0) {
    console.error(cjs.stdout);
    console.error(cjs.stderr);
    throw new Error("packed native Response CJS consumer failed");
  }

  assert.match(
    cjs.stdout,
    /CJS NATIVE RESPONSE PASS/
  );

  console.log("PASS - fresh publishable SDK tarball created");
  console.log("PASS - packed SDK exposes @once-agent/sdk/http-response for ESM and CJS");
  console.log("PASS - packed helper reconstructs a real native Response with replay-v2 metadata");
  console.log("PASS - clone/bodyUsed/text/json/header immutability survive the package boundary");
  console.log("PASS - legacy v1 and malformed v2 receipts fail closed");
} finally {
  await rm(packDirectory, { recursive: true, force: true });
  await rm(sandbox, { recursive: true, force: true });
}

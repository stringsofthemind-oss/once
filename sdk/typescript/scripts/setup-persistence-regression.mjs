import assert from "node:assert/strict";

import {
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  runSetup
} from "../dist/setup.js";

console.log("");
console.log("SETUP CREDENTIAL PERSISTENCE REGRESSION");
console.log("=======================================");

const originalFetch =
  globalThis.fetch;

const originalEnvironment = {
  ONCE_API_KEY:
    process.env.ONCE_API_KEY,
  ONCE_BASE_URL:
    process.env.ONCE_BASE_URL,
  ONCE_SETUP_PROVIDER_NAME:
    process.env.ONCE_SETUP_PROVIDER_NAME,
  ONCE_SETUP_PROVIDER_URL:
    process.env.ONCE_SETUP_PROVIDER_URL,
  ONCE_SETUP_PROVIDER_TOKEN:
    process.env.ONCE_SETUP_PROVIDER_TOKEN
};

const root =
  await mkdtemp(
    path.join(
      os.tmpdir(),
      "once-persistence-regression-"
    )
  );

const apiKey =
  "once_test_PERSISTENCE_SECRET_123456";

try {
  process.env.ONCE_API_KEY =
    apiKey;

  process.env.ONCE_BASE_URL =
    "https://once.test";

  delete process.env
    .ONCE_SETUP_PROVIDER_NAME;

  delete process.env
    .ONCE_SETUP_PROVIDER_URL;

  delete process.env
    .ONCE_SETUP_PROVIDER_TOKEN;

  globalThis.fetch =
    async (
      input,
      init
    ) => {
      const request =
        new Request(
          input,
          init
        );

      const url =
        new URL(
          request.url
        );

      if (
        request.method === "GET" &&
        url.origin ===
          "https://once.test" &&
        url.pathname.startsWith(
          "/v1/truth/"
        )
      ) {
        assert.equal(
          request.headers.get(
            "authorization"
          ),
          `Bearer ${apiKey}`,
          "verification must use the acquired API key"
        );

        return new Response(
          JSON.stringify({
            ledger_state:
              "ABSENT",
            side_effects:
              0
          }),
          {
            status:
              200,
            headers: {
              "content-type":
                "application/json"
            }
          }
        );
      }

      throw new Error(
        "Unexpected request: " +
        request.method +
        " " +
        request.url
      );
    };

  let setupError;

  try {
    await runSetup(
      root,
      {
        autoConfirm:
          true,
        skipInstall:
          false
      }
    );
  }
  catch (error) {
    setupError =
      error;
  }

  assert.ok(
    setupError,
    "setup must fail when no automatic SDK install command can be determined"
  );

  assert.match(
    String(
      setupError?.message ??
      setupError
    ),
    /Could not determine an automatic SDK install command/i,
    "setup must fail for the expected install reason"
  );

  console.log(
    "PASS - SDK installation failed as intended"
  );

  const envText =
    await readFile(
      path.join(
        root,
        ".env"
      ),
      "utf8"
    );

  assert.match(
    envText,
    /^ONCE_API_KEY=.+$/m,
    ".env must contain ONCE_API_KEY despite later install failure"
  );

  assert.ok(
    envText.includes(
      apiKey
    ),
    ".env must contain the verified API key"
  );

  console.log(
    "PASS - verified API key survived later setup failure"
  );

  const gitignore =
    await readFile(
      path.join(
        root,
        ".gitignore"
      ),
      "utf8"
    );

  assert.ok(
    gitignore
      .split(/\r?\n/)
      .map(line => line.trim())
      .includes(".env"),
    ".gitignore must protect .env"
  );

  console.log(
    "PASS - .env remains gitignored"
  );

  console.log(
    "SETUP CREDENTIAL PERSISTENCE REGRESSION PASSED"
  );
}
finally {
  globalThis.fetch =
    originalFetch;

  for (
    const [
      name,
      value
    ] of Object.entries(
      originalEnvironment
    )
  ) {
    if (
      value ===
      undefined
    ) {
      delete process.env[
        name
      ];
    }
    else {
      process.env[
        name
      ] =
        value;
    }
  }

  await rm(
    root,
    {
      recursive:
        true,
      force:
        true
    }
  );
}

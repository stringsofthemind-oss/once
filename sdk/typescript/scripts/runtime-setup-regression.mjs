import assert from "node:assert/strict";

import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  runSetup
} from "../dist/setup.js";


const originalFetch =
  globalThis.fetch;


const environmentNames = [
  "ONCE_API_KEY",
  "ONCE_BASE_URL",
  "ONCE_SETUP_PROVIDER_NAME",
  "ONCE_SETUP_PROVIDER_URL",
  "ONCE_SETUP_PROVIDER_TOKEN",
  "ONCE_SETUP_RUNTIME_TARGET_URL"
];


const originalEnvironment =
  Object.fromEntries(
    environmentNames.map(
      name => [
        name,
        process.env[name]
      ]
    )
  );


async function runCase(
  runtimeHttp
) {

  const root =
    await mkdtemp(
      path.join(
        os.tmpdir(),
        runtimeHttp
          ? "once-runtime-setup-"
          : "once-legacy-setup-"
      )
    );


  const targetUrl =
    "https://api.example.test/v1/payments?a=1&b=2";


  const providerBodies = [];


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
        url.pathname.startsWith(
          "/v1/truth/"
        )
      ) {

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


      if (
        request.method === "POST" &&
        url.pathname ===
          "/v1/providers"
      ) {

        const body =
          await request.json();

        providerBodies.push(
          body
        );


        return new Response(
          JSON.stringify({
            created:
              true,

            rotated:
              false,

            version_id:
              "pv_" +
              "a".repeat(32),

            response_replay:
              body.response_replay ??
              null
          }),
          {
            status:
              201,

            headers: {
              "content-type":
                "application/json"
            }
          }
        );
      }


      throw new Error(
        "Unexpected setup request: " +
        request.method +
        " " +
        request.url
      );
    };


  process.env.ONCE_API_KEY =
    "once_test_key";

  process.env.ONCE_BASE_URL =
    "https://once.test";

  process.env.ONCE_SETUP_PROVIDER_NAME =
    runtimeHttp
      ? "runtime-provider"
      : "legacy-provider";

  process.env.ONCE_SETUP_PROVIDER_URL =
    "https://adapter.example.test";

  process.env.ONCE_SETUP_PROVIDER_TOKEN =
    "provider-secret";

  delete process.env
    .ONCE_SETUP_RUNTIME_TARGET_URL;


  try {

    await writeFile(
      path.join(
        root,
        "package.json"
      ),
      JSON.stringify({
        name:
          "@once-agent/sdk",
        private:
          true
      }),
      "utf8"
    );


    await runSetup(
      root,
      {
        autoConfirm:
          true,

        skipInstall:
          true,

        runtimeHttp,

        runtimeHttpTargetUrl:
          runtimeHttp
            ? targetUrl
            : undefined
      }
    );


    assert.equal(
      providerBodies.length,
      1,
      "setup must register exactly one provider"
    );


    const registration =
      providerBodies[0];


    const config =
      JSON.parse(
        await readFile(
          path.join(
            root,
            ".once",
            "config.json"
          ),
          "utf8"
        )
      );


    if (runtimeHttp) {

      assert.equal(
        registration.response_replay,
        "required"
      );

      assert.deepEqual(
        registration.allowed_urls,
        [
          targetUrl
        ]
      );

      assert.equal(
        config.provider.response_replay,
        "required"
      );

      assert.deepEqual(
        config.provider.allowed_urls,
        [
          targetUrl
        ]
      );
    }
    else {

      assert.equal(
        Object.hasOwn(
          registration,
          "response_replay"
        ),
        false
      );

      assert.equal(
        Object.hasOwn(
          registration,
          "allowed_urls"
        ),
        false
      );

      assert.equal(
        Object.hasOwn(
          config.provider,
          "response_replay"
        ),
        false
      );

      assert.equal(
        Object.hasOwn(
          config.provider,
          "allowed_urls"
        ),
        false
      );
    }
  }
  finally {

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
}


try {

  await runCase(
    false
  );

  console.log(
    "PASS - legacy setup payload remains unchanged"
  );


  await runCase(
    true
  );

  console.log(
    "PASS - Runtime setup sends response_replay=required"
  );

  console.log(
    "PASS - Runtime setup sends exact allowed_urls target"
  );

  console.log(
    "PASS - Runtime setup persists non-secret replay metadata"
  );

  console.log(
    "Runtime setup regression: PASS"
  );
}
finally {

  globalThis.fetch =
    originalFetch;


  for (
    const name of environmentNames
  ) {

    const value =
      originalEnvironment[name];

    if (value === undefined) {

      delete process.env[name];
    }
    else {

      process.env[name] =
        value;
    }
  }
}
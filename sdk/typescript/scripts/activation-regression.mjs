import assert from "node:assert/strict";

import {
  acquireApiKeyThroughActivation
} from "../dist/setup.js";


console.log("");
console.log(
  "ONCE ACTIVATION REGRESSION"
);
console.log(
  "=========================="
);


const originalFetch =
  globalThis.fetch;

const originalLog =
  console.log;

const originalActivationBase =
  process.env.ONCE_ACTIVATION_BASE_URL;

const originalPlan =
  process.env.ONCE_SETUP_PLAN;

const originalNoBrowser =
  process.env.ONCE_SETUP_NO_BROWSER;


const secret =
  "once_test_SECRET_DO_NOT_PRINT_123456";

const sessionId =
  "cs_test_once_activation_regression";

const checkoutUrl =
  "https://checkout.invalid/test-session";


let checkoutCalls = 0;
let claimCalls = 0;

const capturedLogs = [];


console.log =
  (...args) => {

    capturedLogs.push(
      args
        .map(value =>
          String(value)
        )
        .join(" ")
    );

    originalLog(
      ...args
    );
  };


process.env.ONCE_ACTIVATION_BASE_URL =
  "https://activation.test";

process.env.ONCE_SETUP_PLAN =
  "startup";

process.env.ONCE_SETUP_NO_BROWSER =
  "1";


globalThis.fetch =
  async (
    input,
    init = {}
  ) => {

    const url =
      new URL(
        String(input)
      );


    // ======================================================
    // CHECKOUT
    // ======================================================

    if (
      url.origin ===
        "https://activation.test" &&
      url.pathname ===
        "/api/checkout"
    ) {

      checkoutCalls += 1;

      assert.equal(
        init.method,
        "POST"
      );


      const body =
        JSON.parse(
          String(
            init.body
          )
        );


      assert.equal(
        body.plan,
        "startup"
      );


      return new Response(
        JSON.stringify({
          url:
            checkoutUrl,

          session_id:
            sessionId
        }),
        {
          status:
            200,

          headers: {
            "content-type":
              "application/json",

            "set-cookie":
              "once_activation=test-cookie-value; Path=/; HttpOnly; Secure; SameSite=Lax"
          }
        }
      );
    }


    // ======================================================
    // CLAIM
    // ======================================================

    if (
      url.origin ===
        "https://activation.test" &&
      url.pathname ===
        "/api/claim"
    ) {

      claimCalls += 1;

      assert.equal(
        init.method,
        "POST"
      );


      const headers =
        new Headers(
          init.headers
        );


      assert.equal(
        headers.get(
          "cookie"
        ),
        "once_activation=test-cookie-value"
      );


      const body =
        JSON.parse(
          String(
            init.body
          )
        );


      assert.equal(
        body.session_id,
        sessionId
      );


      return new Response(
        JSON.stringify({
          created:
            true,

          already_claimed:
            false,

          status:
            "CLAIMED",

          key_id:
            "key_activation_regression",

          api_key:
            secret,

          customer_id:
            "cus_activation_regression",

          plan:
            "startup",

          monthly_limit:
            500000
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
      `Unexpected request: ${url.toString()}`
    );
  };


const fakeReadline = {

  async question(
    prompt
  ) {

    assert.equal(
      prompt,
      "When checkout is complete, press Enter to continue..."
    );

    return "";
  }
};


try {

  const apiKey =
    await acquireApiKeyThroughActivation(
      fakeReadline
    );


  assert.equal(
    apiKey,
    secret,
    "activation helper must return claimed API key"
  );


  assert.equal(
    checkoutCalls,
    1,
    "checkout must be created exactly once"
  );


  assert.equal(
    claimCalls,
    1,
    "credential claim must happen exactly once"
  );


  const renderedOutput =
    capturedLogs.join(
      "\n"
    );


  assert.equal(
    renderedOutput.includes(
      secret
    ),
    false,
    "raw API key must never be printed"
  );


  assert.match(
    renderedOutput,
    /API key received securely/
  );


  assert.match(
    renderedOutput,
    /Plan: startup/
  );


  assert.match(
    renderedOutput,
    /Monthly limit: 500000/
  );


  originalLog(
    "PASS - checkout requested exactly once"
  );

  originalLog(
    "PASS - secure session cookie carried to claim"
  );

  originalLog(
    "PASS - credential claimed exactly once"
  );

  originalLog(
    "PASS - claimed key returned to setup"
  );

  originalLog(
    "PASS - raw API key never printed"
  );

  originalLog(
    ""
  );

  originalLog(
    "ONCE ACTIVATION REGRESSION PASSED"
  );
}
finally {

  globalThis.fetch =
    originalFetch;

  console.log =
    originalLog;


  if (
    originalActivationBase === undefined
  ) {
    delete process.env.ONCE_ACTIVATION_BASE_URL;
  }
  else {
    process.env.ONCE_ACTIVATION_BASE_URL =
      originalActivationBase;
  }


  if (
    originalPlan === undefined
  ) {
    delete process.env.ONCE_SETUP_PLAN;
  }
  else {
    process.env.ONCE_SETUP_PLAN =
      originalPlan;
  }


  if (
    originalNoBrowser === undefined
  ) {
    delete process.env.ONCE_SETUP_NO_BROWSER;
  }
  else {
    process.env.ONCE_SETUP_NO_BROWSER =
      originalNoBrowser;
  }
}

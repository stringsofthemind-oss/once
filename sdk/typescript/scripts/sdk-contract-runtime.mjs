import assert from "node:assert/strict";
import {
  readFile
} from "node:fs/promises";

import {
  Once
} from "../dist/index.js";

const setupSource =
  await readFile(
    new URL(
      "../src/setup.ts",
      import.meta.url
    ),
    "utf8"
  );

assert.ok(
  setupSource.includes(
    '"  const operationId = Once.id("'
  ),
  "Setup quickstart must generate a stable operationId with Once.id"
);

assert.ok(
  setupSource.includes(
    '"    operationId,"'
  ),
  "Setup quickstart must pass operationId to execute()"
);

assert.ok(
  setupSource.includes(
    '"async function main() {"'
  ),
  "Setup quickstart must avoid top-level await"
);

assert.ok(
  setupSource.includes(
    '"  node --env-file=.env app.mjs"'
  ),
  "Setup quickstart must explain vanilla Node .env loading"
);

assert.ok(
  !setupSource.includes(
    'id: "YOUR_STABLE_OPERATION_ID"'
  ),
  "Setup quickstart must not use legacy id"
);

const originalFetch =
  globalThis.fetch;

let executeCalls = 0;

globalThis.fetch =
  async (
    input,
    init = {}
  ) => {

    const url =
      new URL(
        typeof input === "string"
          ? input
          : input.url
      );

    const method =
      String(
        init.method || "GET"
      ).toUpperCase();

    if (
      method === "POST" &&
      url.pathname ===
        "/v1/execute"
    ) {
      executeCalls += 1;

      const body =
        JSON.parse(
          String(
            init.body || "{}"
          )
        );

      assert.equal(
        body.operation_id,
        "contract-operation",
        "SDK must send operationId as operation_id"
      );

      assert.equal(
        "id" in body,
        false,
        "SDK must not send legacy id field"
      );

      assert.equal(
        body.provider,
        "contract-provider"
      );

      assert.deepEqual(
        body.action,
        {
          type:
            "contract_test"
        }
      );

      return new Response(
        JSON.stringify({
          operation_id:
            "contract-operation",
          provider:
            "contract-provider",
          state:
            "CONFIRMED",
          result:
            executeCalls === 1
              ? "executed"
              : "already_executed",
          attempts:
            executeCalls,
          side_effects:
            1
        }),
        {
          status: 200,
          headers: {
            "content-type":
              "application/json"
          }
        }
      );
    }

    if (
      method === "GET" &&
      url.pathname ===
        "/v1/truth/contract-operation"
    ) {
      return new Response(
        JSON.stringify({
          operation_id:
            "contract-operation",
          provider:
            "contract-provider",
          ledger_state:
            "CONFIRMED",
          attempts:
            2,
          side_effects:
            1
        }),
        {
          status: 200,
          headers: {
            "content-type":
              "application/json"
          }
        }
      );
    }

    throw new Error(
      `Unexpected mocked request: ${method} ${url.pathname}`
    );
  };

try {

  const once =
    new Once({
      apiKey:
        "contract-test-key",
      baseUrl:
        "https://contract.invalid"
    });

  const first =
    await once.execute({
      operationId:
        "contract-operation",
      provider:
        "contract-provider",
      action: {
        type:
          "contract_test"
      }
    });

  assert.equal(
    first.result,
    "executed"
  );

  assert.equal(
    first.state,
    "CONFIRMED"
  );

  assert.equal(
    first.side_effects,
    1
  );

  assert.equal(
    first.ledger_state,
    undefined,
    "execute() contract uses state, not ledger_state"
  );

  const retry =
    await once.execute({
      operationId:
        "contract-operation",
      provider:
        "contract-provider",
      action: {
        type:
          "contract_test"
      }
    });

  assert.equal(
    retry.result,
    "already_executed"
  );

  assert.equal(
    retry.state,
    "CONFIRMED"
  );

  assert.equal(
    retry.side_effects,
    1
  );

  const truth =
    await once.truth(
      "contract-operation"
    );

  assert.equal(
    truth.ledger_state,
    "CONFIRMED"
  );

  assert.equal(
    truth.side_effects,
    1
  );

  assert.equal(
    truth.state,
    undefined,
    "truth() contract uses ledger_state, not state"
  );

  assert.equal(
    executeCalls,
    2
  );

} finally {
  globalThis.fetch =
    originalFetch;
}

console.log("");
console.log(
  "ONCE SDK CONTRACT TEST PASSED"
);

console.log(
  "operationId -> operation_id: PASS"
);

console.log(
  "execute().state: PASS"
);

console.log(
  "truth().ledger_state: PASS"
);

console.log(
  "Setup quickstart contract: PASS"
);
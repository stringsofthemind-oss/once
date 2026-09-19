import {
  strict as assert
} from "node:assert";

import {
  writeFile,
  rm
} from "node:fs/promises";

import {
  pathToFileURL
} from "node:url";

import path from "node:path";

import {
  transformHttpWriteV1,
  HTTP_WRITE_TRANSFORMER_ID
} from "../dist/transformers/http-write-v1.js";

console.log("");
console.log(
  "ONCE HTTP TRANSFORMER REGRESSION"
);
console.log(
  "================================"
);

const goodFunction = `
export async function createOrder(
  operationId: string,
  payload: unknown
) {
  await fetch(
    "https://api.example.invalid/orders",
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
}
`;

const goodStatement = `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    body: JSON.stringify(payload)
  }
);
`;

const good =
  transformHttpWriteV1({
    statement:
      goodStatement,
    functionSource:
      goodFunction,
    provider:
      "customer-http"
  });

assert.equal(
  good.eligible,
  true,
  "Known-safe fixture should be transformable"
);

if (!good.eligible) {
  throw new Error(
    good.reason
  );
}

assert.equal(
  good.transformer,
  HTTP_WRITE_TRANSFORMER_ID
);

assert.equal(
  good.actionType,
  "http_write_v1"
);

assert.equal(
  good.method,
  "POST"
);

assert.equal(
  good.url,
  "https://api.example.invalid/orders"
);

assert.equal(
  good.bodyExpression,
  "payload"
);

assert.match(
  good.replacement,
  /operationId/
);

assert.match(
  good.replacement,
  /provider: "customer-http"/
);

assert.match(
  good.replacement,
  /body_json: JSON\.stringify\(payload\)/
);

console.log(
  "PASS - exact supported POST pattern transformed"
);

console.log(
  "PASS - stable operationId preserved"
);

console.log(
  "PASS - provider preserved"
);

console.log(
  "PASS - serialized request body preserved"
);

//
// Missing stable operation ID
//

const noOperationId =
  transformHttpWriteV1({
    statement:
      goodStatement,
    functionSource: `
      async function createOrder(
        payload: unknown
      ) {}
    `,
    provider:
      "customer-http"
  });

assert.equal(
  noOperationId.eligible,
  false
);

console.log(
  "PASS - missing operationId rejected"
);

//
// Returned Fetch Response
//

const returned =
  transformHttpWriteV1({
    statement: `
      return await fetch(
        "https://api.example.invalid/orders",
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );
    `,
    functionSource:
      goodFunction,
    provider:
      "customer-http"
  });

assert.equal(
  returned.eligible,
  false
);

console.log(
  "PASS - returned fetch Response rejected"
);

//
// Assigned Fetch Response
//

const assigned =
  transformHttpWriteV1({
    statement: `
      const response =
        await fetch(
          "https://api.example.invalid/orders",
          {
            method: "POST",
            body: JSON.stringify(payload)
          }
        );
    `,
    functionSource:
      goodFunction,
    provider:
      "customer-http"
  });

assert.equal(
  assigned.eligible,
  false
);

console.log(
  "PASS - assigned fetch Response rejected"
);

//
// Dynamic URL
//

const dynamicUrl =
  transformHttpWriteV1({
    statement: `
      await fetch(
        endpoint,
        {
          method: "POST",
          body: JSON.stringify(payload)
        }
      );
    `,
    functionSource:
      goodFunction,
    provider:
      "customer-http"
  });

assert.equal(
  dynamicUrl.eligible,
  false
);

console.log(
  "PASS - dynamic URL rejected"
);

//
// Unsupported headers
//

const headers =
  transformHttpWriteV1({
    statement: `
      await fetch(
        "https://api.example.invalid/orders",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify(payload)
        }
      );
    `,
    functionSource:
      goodFunction,
    provider:
      "customer-http"
  });

assert.equal(
  headers.eligible,
  false
);

console.log(
  "PASS - unsupported fetch options rejected"
);

//
// Wrong method
//

const put =
  transformHttpWriteV1({
    statement: `
      await fetch(
        "https://api.example.invalid/orders",
        {
          method: "PUT",
          body: JSON.stringify(payload)
        }
      );
    `,
    functionSource:
      goodFunction,
    provider:
      "customer-http"
  });

assert.equal(
  put.eligible,
  false
);

console.log(
  "PASS - non-POST method rejected"
);

//
// Non-JSON body
//

const rawBody =
  transformHttpWriteV1({
    statement: `
      await fetch(
        "https://api.example.invalid/orders",
        {
          method: "POST",
          body: payload
        }
      );
    `,
    functionSource:
      goodFunction,
    provider:
      "customer-http"
  });

assert.equal(
  rawBody.eligible,
  false
);

console.log(
  "PASS - unsupported body encoding rejected"
);

//
// Empty provider
//

const noProvider =
  transformHttpWriteV1({
    statement:
      goodStatement,
    functionSource:
      goodFunction,
    provider:
      ""
  });

assert.equal(
  noProvider.eligible,
  false
);

console.log(
  "PASS - missing provider rejected"
);

//
// Generated replacement must be valid JS syntax.
// We execute only against a local fake once binding.
// No network call occurs.
//

const syntaxFile =
  path.join(
    process.cwd(),
    ".transformer-syntax-test.mjs"
  );

const executable = `
const calls = [];

const once = {
  async execute(input) {
    calls.push(input);
    return {
      state: "CONFIRMED"
    };
  }
};

const operationId =
  "op-transformer-proof";

const payload = {
  order: 123
};

async function run() {
${good.replacement
  .split("\n")
  .map(
    line =>
      "  " + line
  )
  .join("\n")}
}

await run();

if (calls.length !== 1) {
  throw new Error(
    "Expected exactly one Once call"
  );
}

if (
  calls[0].operationId !==
  "op-transformer-proof"
) {
  throw new Error(
    "operationId was not preserved"
  );
}

if (
  calls[0].provider !==
  "customer-http"
) {
  throw new Error(
    "provider was not preserved"
  );
}

if (
  calls[0].action.body_json !==
  JSON.stringify(payload)
) {
  throw new Error(
    "serialized body changed"
  );
}
`;

await writeFile(
  syntaxFile,
  executable,
  "utf8"
);

try {

  await import(
    pathToFileURL(
      syntaxFile
    ).href +
      `?t=${Date.now()}`
  );

} finally {

  await rm(
    syntaxFile,
    {
      force: true
    }
  );
}

console.log(
  "PASS - generated replacement executes against fake Once binding"
);

console.log(
  "PASS - generated replacement issues exactly one Once call"
);

console.log("");
console.log(
  "ONCE HTTP TRANSFORMER REGRESSION PASSED"
);
import {
  strict as assert
} from "node:assert";

import {
  rm,
  writeFile
} from "node:fs/promises";

import {
  pathToFileURL
} from "node:url";

import path from "node:path";

import {
  bindOnceCallSiteV1,
  ONCE_CLIENT_ALIAS,
  ONCE_IMPORT
} from "../dist/transformers/once-binding-v1.js";

console.log("");
console.log(
  "ONCE CALL-SITE BINDING REGRESSION"
);

console.log(
  "================================="
);

const source = `
export async function createOrder(
  operationId: string,
  payload: unknown
) {
  // consequential operation
}
`.trimStart();

const replacement = `
await once.execute({
  operationId,
  provider: "customer-http",
  action: {
    type: "http_write_v1",
    method: "POST",
    url: "https://api.example.invalid/orders",
    body_json: JSON.stringify(payload)
  }
});
`.trim();

const result =
  bindOnceCallSiteV1(
    source,
    replacement
  );

assert.equal(
  result.eligible,
  true
);

if (!result.eligible) {
  throw new Error(
    result.reason
  );
}

assert.equal(
  result.importStatement,
  ONCE_IMPORT
);

assert.equal(
  result.clientAlias,
  ONCE_CLIENT_ALIAS
);

assert.equal(
  result.constructorTiming,
  "call-site"
);

assert.match(
  result.sourceWithImport,
  /^import \{ Once as __OnceAgentClient \} from "@once-agent\/sdk";/
);

assert.match(
  result.boundReplacement,
  /await new __OnceAgentClient\(\)\.execute\(/
);

assert.doesNotMatch(
  result.boundReplacement,
  /\bawait once\.execute\(/
);

console.log(
  "PASS - deterministic SDK import generated"
);

console.log(
  "PASS - client constructed at original call site"
);

console.log(
  "PASS - transformer replacement bound to SDK client"
);

//
// Preserve use-client / directive semantics.
//

const directiveSource = `
"use client";

export async function action() {}
`.trimStart();

const directive =
  bindOnceCallSiteV1(
    directiveSource,
    replacement
  );

assert.equal(
  directive.eligible,
  true
);

if (!directive.eligible) {
  throw new Error(
    directive.reason
  );
}

assert.match(
  directive.sourceWithImport,
  /^"use client";\r?\nimport \{ Once as __OnceAgentClient \}/
);

console.log(
  "PASS - directive prologue preserved"
);

//
// Preserve shebang.
//

const shebangSource = `#!/usr/bin/env node
export async function action() {}
`;

const shebang =
  bindOnceCallSiteV1(
    shebangSource,
    replacement
  );

assert.equal(
  shebang.eligible,
  true
);

if (!shebang.eligible) {
  throw new Error(
    shebang.reason
  );
}

assert.match(
  shebang.sourceWithImport,
  /^#!\/usr\/bin\/env node\r?\nimport \{ Once as __OnceAgentClient \}/
);

console.log(
  "PASS - shebang preserved"
);

//
// Reserved alias collision must fail closed.
//

const collision =
  bindOnceCallSiteV1(
    `
const __OnceAgentClient = {};

export async function action() {}
`,
    replacement
  );

assert.equal(
  collision.eligible,
  false
);

console.log(
  "PASS - client alias collision rejected"
);

//
// CommonJS/script source is outside v0.8.
//

const commonJs =
  bindOnceCallSiteV1(
    `
async function action() {}
module.exports = {
  action
};
`,
    replacement
  );

assert.equal(
  commonJs.eligible,
  false
);

console.log(
  "PASS - unsupported module format rejected"
);

//
// Missing transformer call must fail closed.
//

const missingCall =
  bindOnceCallSiteV1(
    source,
    "await somethingElse();"
  );

assert.equal(
  missingCall.eligible,
  false
);

console.log(
  "PASS - missing transformer call rejected"
);

//
// Multiple generated calls must fail closed.
//

const multipleCalls =
  bindOnceCallSiteV1(
    source,
    replacement +
      "\n" +
      replacement
  );

assert.equal(
  multipleCalls.eligible,
  false
);

console.log(
  "PASS - ambiguous multiple calls rejected"
);

//
// Critical timing property:
// constructing the Once client must happen only
// when the transformed operation itself executes.
//

let constructions =
  0;

class __OnceAgentClient {
  constructor() {
    constructions++;
  }

  async execute(input) {
    globalThis.__onceBindingTestCall =
      input;

    return {
      state:
        "CONFIRMED"
    };
  }
}

const operationId =
  "binding-proof-op";

const payload = {
  order:
    123
};

assert.equal(
  constructions,
  0,
  "Once client must not be constructed before operation execution"
);

const runtimeFile =
  path.join(
    process.cwd(),
    ".once-binding-runtime-test.mjs"
  );

const executable = `
let constructions = 0;

class __OnceAgentClient {
  constructor() {
    constructions++;
  }

  async execute(input) {
    globalThis.__onceBindingTestCall =
      input;

    return {
      state: "CONFIRMED"
    };
  }
}

const operationId =
  "binding-proof-op";

const payload = {
  order: 123
};

if (constructions !== 0) {
  throw new Error(
    "Client constructed before operation"
  );
}

async function run() {
${result.boundReplacement
  .split("\n")
  .map(
    line =>
      "  " + line
  )
  .join("\n")}
}

if (constructions !== 0) {
  throw new Error(
    "Client constructed before run()"
  );
}

await run();

if (constructions !== 1) {
  throw new Error(
    "Expected exactly one call-site construction"
  );
}

if (
  globalThis.__onceBindingTestCall.operationId !==
  "binding-proof-op"
) {
  throw new Error(
    "operationId was not preserved"
  );
}

if (
  globalThis.__onceBindingTestCall.provider !==
  "customer-http"
) {
  throw new Error(
    "provider was not preserved"
  );
}
`;

await writeFile(
  runtimeFile,
  executable,
  "utf8"
);

try {

  await import(
    pathToFileURL(
      runtimeFile
    ).href +
      `?t=${Date.now()}`
  );

} finally {

  await rm(
    runtimeFile,
    {
      force: true
    }
  );
}

console.log(
  "PASS - client not constructed during module setup"
);

console.log(
  "PASS - exactly one client constructed when operation executes"
);

console.log(
  "PASS - operationId/provider preserved through binding"
);

console.log("");
console.log(
  "ONCE CALL-SITE BINDING REGRESSION PASSED"
);
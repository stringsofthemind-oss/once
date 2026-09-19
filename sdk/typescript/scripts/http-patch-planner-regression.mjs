import {
  strict as assert
} from "node:assert";

import * as ts
  from "typescript";

import {
  buildHttpWritePatchV1,
  HTTP_WRITE_PATCH_PLAN_ID
} from "../dist/transformers/http-patch-plan-v1.js";

console.log("");
console.log(
  "ONCE HTTP PATCH-PLANNER REGRESSION"
);

console.log(
  "=================================="
);

const source = `
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
`.trimStart();

const statement = `
await fetch(
    "https://api.example.invalid/orders",
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
`.trim();

const plan =
  buildHttpWritePatchV1({
    source,
    statement,
    functionSource:
      source,
    provider:
      "customer-http"
  });

assert.equal(
  plan.eligible,
  true
);

if (!plan.eligible) {
  throw new Error(
    plan.reason
  );
}

assert.equal(
  plan.patchPlan,
  HTTP_WRITE_PATCH_PLAN_ID
);

assert.equal(
  plan.transformerId,
  "ts_fetch_post_void_v1"
);

assert.equal(
  plan.bindingStrategy,
  "call-site-constructor"
);

assert.match(
  plan.proposedSource,
  /^import \{ Once as __OnceAgentClient \} from "@once-agent\/sdk";/
);

assert.match(
  plan.proposedSource,
  /await new __OnceAgentClient\(\)\.execute\(/
);

assert.doesNotMatch(
  plan.proposedSource,
  /await\s+fetch\s*\(/
);

assert.notEqual(
  plan.sourceSha256,
  plan.proposedSourceSha256
);

console.log(
  "PASS - complete proposed source generated"
);

console.log(
  "PASS - SDK import included exactly once"
);

console.log(
  "PASS - original fetch statement removed"
);

console.log(
  "PASS - bound Once execution inserted"
);

//
// Ensure the proposed TypeScript is syntactically valid.
//

const transpiled =
  ts.transpileModule(
    plan.proposedSource,
    {
      compilerOptions: {
        target:
          ts.ScriptTarget.ES2022,

        module:
          ts.ModuleKind.ESNext
      },

      reportDiagnostics:
        true
    }
  );

const errors =
  (
    transpiled.diagnostics ??
    []
  ).filter(
    diagnostic =>
      diagnostic.category ===
      ts.DiagnosticCategory.Error
  );

if (
  errors.length > 0
) {
  throw new Error(
    "Proposed source contains TypeScript syntax errors."
  );
}

console.log(
  "PASS - proposed TypeScript parses/transpiles"
);

//
// Determinism proof.
//

const second =
  buildHttpWritePatchV1({
    source,
    statement,
    functionSource:
      source,
    provider:
      "customer-http"
  });

assert.equal(
  second.eligible,
  true
);

if (!second.eligible) {
  throw new Error(
    second.reason
  );
}

assert.equal(
  second.proposedSourceSha256,
  plan.proposedSourceSha256
);

assert.equal(
  second.proposedSource,
  plan.proposedSource
);

console.log(
  "PASS - patch generation deterministic"
);

//
// Alias collision must fail closed.
//

const collision =
  buildHttpWritePatchV1({
    source: `
const __OnceAgentClient = {};

${source}
`.trimStart(),

    statement,

    functionSource:
      source,

    provider:
      "customer-http"
  });

assert.equal(
  collision.eligible,
  false
);

console.log(
  "PASS - binding collision prevents patchability"
);

//
// Duplicate exact side effects are ambiguous.
//

const duplicateSource =
  source.replace(
    statement,
    statement +
      "\n  " +
      statement
  );

const duplicate =
  buildHttpWritePatchV1({
    source:
      duplicateSource,

    statement,

    functionSource:
      duplicateSource,

    provider:
      "customer-http"
  });

assert.equal(
  duplicate.eligible,
  false
);

console.log(
  "PASS - ambiguous duplicate statement rejected"
);

//
// Missing stable operationId still rejected.
//

const missingOperationIdSource = `
export async function createOrder(
  payload: unknown
) {
  ${statement}
}
`.trimStart();

const missingOperationId =
  buildHttpWritePatchV1({
    source:
      missingOperationIdSource,

    statement,

    functionSource:
      missingOperationIdSource,

    provider:
      "customer-http"
  });

assert.equal(
  missingOperationId.eligible,
  false
);

console.log(
  "PASS - missing stable operationId rejected"
);

console.log("");
console.log(
  "ONCE HTTP PATCH-PLANNER REGRESSION PASSED"
);
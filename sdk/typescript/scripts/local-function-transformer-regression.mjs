import assert from "node:assert/strict";
import ts from "typescript";
import {
  LOCAL_FUNCTION_PATCH_V1,
  LOCAL_FUNCTION_TRANSFORMER_V1,
  analyzeLocalFunctionV1,
  buildLocalFunctionPatchV1,
} from "../dist/transformers/local-function-v1.js";

function lineOf(source, marker) {
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, `missing marker: ${marker}`);
  return source.slice(0, index).split("\n").length;
}

function fixture(id, fileName, category, source, functionName = "submit") {
  return {
    id,
    fileName,
    category,
    source,
    functionName,
    findingLine: lineOf(source, `export const ${functionName}`),
  };
}

const fixtures = [
  {
    ...fixture(
      "cu3-order-wrapper",
      "orders.mjs",
      "BOOKING",
      [
        "export const provider = {",
        "  async createOrder({ orderId, amountCents }) {",
        "    return { orderId, amountCents, status: \"created\" };",
        "  }",
        "};",
        "",
        "export const createOrder = async ({ orderId, amountCents }) =>",
        "  provider.createOrder({ orderId, amountCents });",
        "",
      ].join("\n"),
      "createOrder",
    ),
    expectedEligible: true,
  },
  {
    ...fixture(
      "neutral-name-order-wrapper",
      "neutral.mjs",
      "BOOKING",
      [
        "export const submit = async ({ orderId, amountCents }) =>",
        "  provider.createOrder({ orderId, amountCents });",
        "",
      ].join("\n"),
    ),
    expectedEligible: true,
  },
  {
    ...fixture(
      "block-body",
      "block-body.mjs",
      "BOOKING",
      [
        "export const submit = async ({ orderId, amountCents }) => {",
        "  return provider.createOrder({ orderId, amountCents });",
        "};",
        "",
      ].join("\n"),
    ),
    expectedEligible: false,
  },
  {
    ...fixture(
      "multiple-effects",
      "multiple-effects.mjs",
      "BOOKING",
      [
        "export const submit = async ({ orderId, amountCents }) => {",
        "  await provider.createOrder({ orderId, amountCents });",
        "  return provider.createOrder({ orderId, amountCents });",
        "};",
        "",
      ].join("\n"),
    ),
    expectedEligible: false,
  },
  {
    ...fixture(
      "plain-js-module-mode",
      "plain.js",
      "BOOKING",
      [
        "export const submit = async ({ orderId, amountCents }) =>",
        "  provider.createOrder({ orderId, amountCents });",
        "",
      ].join("\n"),
    ),
    expectedEligible: false,
  },
  {
    ...fixture(
      "default-destructured-value",
      "default.mjs",
      "BOOKING",
      [
        "export const submit = async ({ orderId, amountCents = 100 }) =>",
        "  provider.createOrder({ orderId, amountCents });",
        "",
      ].join("\n"),
    ),
    expectedEligible: false,
  },
  {
    ...fixture(
      "provider-handle-parameter",
      "provider-parameter.mjs",
      "BOOKING",
      [
        "export const submit = async ({ provider, orderId, amountCents }) =>",
        "  provider.createOrder({ orderId, amountCents });",
        "",
      ].join("\n"),
    ),
    expectedEligible: false,
  },
  {
    ...fixture(
      "non-booking-category",
      "message.mjs",
      "MESSAGING",
      [
        "export const submit = async ({ messageId, body }) =>",
        "  provider.sendMessage({ messageId, body });",
        "",
      ].join("\n"),
    ),
    expectedEligible: false,
  },
  {
    ...fixture(
      "aliased-destructuring",
      "alias.mjs",
      "BOOKING",
      [
        "export const submit = async ({ orderId: id, amountCents }) =>",
        "  provider.createOrder({ orderId: id, amountCents });",
        "",
      ].join("\n"),
    ),
    expectedEligible: false,
  },
  {
    ...fixture(
      "rest-destructuring",
      "rest.mjs",
      "BOOKING",
      [
        "export const submit = async ({ orderId, ...rest }) =>",
        "  provider.createOrder({ orderId, amountCents: rest.amountCents });",
        "",
      ].join("\n"),
    ),
    expectedEligible: false,
  },
];

console.log("");
console.log("LOCAL-FUNCTION TRANSFORMER V1 REGRESSION");
console.log("========================================");

let accepted = 0;
let rejected = 0;

for (const item of fixtures) {
  const result = analyzeLocalFunctionV1(item);
  assert.equal(
    result.eligible,
    item.expectedEligible,
    `${item.id}: expected eligible=${item.expectedEligible}; got ${result.eligible}${result.eligible ? "" : ` (${result.reason})`}`,
  );

  if (result.eligible) {
    accepted += 1;
    assert.equal(result.transformer, LOCAL_FUNCTION_TRANSFORMER_V1);
    assert.deepEqual(result.inputFields, ["orderId", "amountCents"]);
    assert.equal(result.receiver, "provider");
    assert.equal(result.method, "createOrder");
    console.log(`ACCEPTED  ${item.id}`);
  } else {
    rejected += 1;
    assert.ok(result.reason.length > 0);
    console.log(`REJECTED  ${item.id}  ${result.reason}`);
  }
}

assert.equal(fixtures.length, 10);
assert.equal(accepted, 2);
assert.equal(rejected, 8);

const cu3 = fixtures[0];
const original = cu3.source;
const patchInput = {
  ...cu3,
  idField: "orderId",
  idPrefix: "create-order",
};

const firstPatch = buildLocalFunctionPatchV1(patchInput);
assert.equal(firstPatch.eligible, true);
if (!firstPatch.eligible) throw new Error(firstPatch.reason);

const secondPatch = buildLocalFunctionPatchV1(patchInput);
assert.deepEqual(secondPatch, firstPatch, "patch planning must be deterministic");
assert.equal(cu3.source, original, "planning must not mutate caller source");
assert.equal(firstPatch.transformer, LOCAL_FUNCTION_TRANSFORMER_V1);
assert.equal(firstPatch.patchPlan, LOCAL_FUNCTION_PATCH_V1);
assert.equal(firstPatch.bindingStrategy, "esm_import_protect_local_v1");
assert.equal(firstPatch.idField, "orderId");
assert.equal(firstPatch.idPrefix, "create-order");
assert.deepEqual(firstPatch.inputFields, ["orderId", "amountCents"]);
assert.notEqual(firstPatch.sourceSha256, firstPatch.proposedSourceSha256);

assert.match(
  firstPatch.proposedSource,
  /import \{ Once as __OnceAgentId, protectLocal as __OnceProtectLocal \} from "@once-agent\/sdk";/,
);
assert.match(firstPatch.proposedSource, /export const createOrder = __OnceProtectLocal\(/);
assert.match(firstPatch.proposedSource, /__OnceAgentId\.id\("create-order", orderId\)/);
assert.match(
  firstPatch.proposedSource,
  /payload: \(\{ orderId, amountCents \}\) => \(\{ orderId, amountCents \}\)/,
);
assert.equal(
  (firstPatch.proposedSource.match(/provider\.createOrder/g) ?? []).length,
  1,
  "the original consequential call must remain exactly once inside the protected wrapper",
);

const transpiled = ts.transpileModule(firstPatch.proposedSource, {
  fileName: cu3.fileName,
  reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const syntaxErrors = (transpiled.diagnostics ?? []).filter(
  diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.equal(
  syntaxErrors.length,
  0,
  syntaxErrors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"),
);

const missingId = buildLocalFunctionPatchV1({
  ...patchInput,
  idField: "requestId",
});
assert.equal(missingId.eligible, false);
assert.match(missingId.reason, /not present/);

const emptyPrefix = buildLocalFunctionPatchV1({
  ...patchInput,
  idPrefix: "",
});
assert.equal(emptyPrefix.eligible, false);
assert.match(emptyPrefix.reason, /explicit nonempty literal identity prefix/);

const controlPrefix = buildLocalFunctionPatchV1({
  ...patchInput,
  idPrefix: "create\norder",
});
assert.equal(controlPrefix.eligible, false);

const collisionSource = `const __OnceProtectLocal = null;\n${cu3.source}`;
const collision = buildLocalFunctionPatchV1({
  ...patchInput,
  source: collisionSource,
  findingLine: lineOf(collisionSource, "export const createOrder"),
});
assert.equal(collision.eligible, false);
assert.match(collision.reason, /collide/);

console.log("");
console.log(`Accepted contract fixtures: ${accepted}`);
console.log(`Rejected contract fixtures: ${rejected}`);
console.log("Deterministic patch planning: PASS");
console.log("Explicit identity requirement: PASS");
console.log("Generated syntax verification: PASS");

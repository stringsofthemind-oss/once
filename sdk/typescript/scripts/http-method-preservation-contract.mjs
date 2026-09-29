import assert from "node:assert/strict";

import {
  transformHttpWriteV1
} from "../dist/transformers/http-write-v1.js";

const functionSource = `
async function consequentialWrite(operationId, payload, verb) {
  // Fixture source context for transformer eligibility checks.
}
`;

const fixtures = [
  {
    id: "post-control",
    methodSource: '"POST"',
    targetSafe: true,
    expectedEligibleNow: true
  },
  {
    id: "put-literal",
    methodSource: '"PUT"',
    targetSafe: true,
    expectedEligibleNow: false
  },
  {
    id: "patch-literal",
    methodSource: '"PATCH"',
    targetSafe: true,
    expectedEligibleNow: false
  },
  {
    id: "delete-literal",
    methodSource: '"DELETE"',
    targetSafe: true,
    expectedEligibleNow: false
  },

  // Everything below is intentionally outside the future-safe literal
  // consequential-method boundary and must remain fail-closed.
  {
    id: "get-literal",
    methodSource: '"GET"',
    targetSafe: false,
    expectedEligibleNow: false
  },
  {
    id: "head-literal",
    methodSource: '"HEAD"',
    targetSafe: false,
    expectedEligibleNow: false
  },
  {
    id: "options-literal",
    methodSource: '"OPTIONS"',
    targetSafe: false,
    expectedEligibleNow: false
  },
  {
    id: "dynamic-method-identifier",
    methodSource: "verb",
    targetSafe: false,
    expectedEligibleNow: false
  },
  {
    id: "template-method",
    methodSource: "`PUT`",
    targetSafe: false,
    expectedEligibleNow: false
  },
  {
    id: "lowercase-put",
    methodSource: '"put"',
    targetSafe: false,
    expectedEligibleNow: false
  },
  {
    id: "mixed-case-patch",
    methodSource: '"Patch"',
    targetSafe: false,
    expectedEligibleNow: false
  }
];

function makeStatement(methodSource) {
  return `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: ${methodSource},
    body: JSON.stringify(payload)
  }
);
`;
}

const results = [];

console.log("HTTP METHOD PRESERVATION CONTRACT");
console.log("=================================");

for (const fixture of fixtures) {
  const result = transformHttpWriteV1({
    statement: makeStatement(fixture.methodSource),
    functionSource,
    provider: "customer-http"
  });

  assert.equal(
    result.eligible,
    fixture.expectedEligibleNow,
    [
      fixture.id,
      `expected eligible now=${fixture.expectedEligibleNow}`,
      `actual eligible=${result.eligible}`,
      `reason=${result.reason ?? "<none>"}`
    ].join(" | ")
  );

  if (!result.eligible) {
    assert.equal(
      typeof result.reason,
      "string",
      `${fixture.id}: rejected fixture must provide a reason`
    );

    assert.ok(
      result.reason.length > 0,
      `${fixture.id}: rejection reason must not be empty`
    );
  }

  results.push({
    ...fixture,
    eligible: result.eligible,
    reason: result.eligible ? null : result.reason
  });

  console.log(
    `${result.eligible ? "ELIGIBLE" : "REJECTED"}  ` +
    `${fixture.targetSafe ? "TARGET-SAFE" : "MUST-REJECT"}  ` +
    fixture.id +
    (result.eligible ? "" : `  ${result.reason ?? "<no reason>"}`)
  );
}

const duplicateMethodStatement = `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    method: "PUT",
    body: JSON.stringify(payload)
  }
);
`;

const duplicateMethodResult = transformHttpWriteV1({
  statement: duplicateMethodStatement,
  functionSource,
  provider: "customer-http"
});

assert.equal(
  duplicateMethodResult.eligible,
  false,
  "duplicate method properties must remain fail-closed"
);
assert.equal(
  typeof duplicateMethodResult.reason,
  "string",
  "duplicate method rejection must provide a reason"
);

console.log(
  `REJECTED  MUST-REJECT  duplicate-method  ${duplicateMethodResult.reason}`
);

const targetSafe = results.filter((result) => result.targetSafe).length;
const targetSafeFuture = results.filter(
  (result) => result.targetSafe && result.id !== "post-control"
).length;
const mustReject = results.filter((result) => !result.targetSafe).length + 1;
const currentlyEligible = results.filter((result) => result.eligible).length;

assert.equal(targetSafe, 4);
assert.equal(targetSafeFuture, 3);
assert.equal(mustReject, 8);
assert.equal(currentlyEligible, 1);

console.log("");
console.log(`Contract fixtures:          ${results.length + 1}`);
console.log(`Target-safe methods:        ${targetSafe}`);
console.log(`Future-safe additions:      ${targetSafeFuture}`);
console.log(`Must-remain-rejected:       ${mustReject}`);
console.log(`Currently eligible:         ${currentlyEligible}`);
console.log("");
console.log(
  "PASS - method preservation boundary pinned; production remains POST-only"
);

import assert from "node:assert/strict";

import {
  transformHttpWriteV1
} from "../dist/transformers/http-write-v1.js";

const provider = "example";

const functionSource = `
async function createOrder(operationId, payload) {
  // Fixture source context for transformer eligibility checks.
}
`;
function splitFixtureSource(source) {
  const fetchIndex = source.indexOf("await fetch(");

  if (fetchIndex === -1) {
    return {
      declarations: "",
      statement: source
    };
  }

  return {
    declarations:
      source.slice(0, fetchIndex).trim(),
    statement:
      source.slice(fetchIndex).trim()
  };
}

const cases = [
  {
    id: "const-content-type-reference",
    futureEligible: true,
    statement: `
const headers = {
  "Content-Type": "application/json"
};

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  },
  {
    id: "const-content-type-and-api-version-reference",
    futureEligible: true,
    statement: `
const headers = {
  "Content-Type": "application/json",
  "X-API-Version": "2026-09-01"
};

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  },
  {
    id: "const-api-version-only-reference",
    futureEligible: true,
    statement: `
const requestHeaders = {
  "X-API-Version": "2026-09-01"
};

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(payload)
  }
);`
  },

  // Everything below MUST remain fail-closed.

  {
    id: "let-reference",
    futureEligible: false,
    statement: `
let headers = {
  "Content-Type": "application/json"
};

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  },
  {
    id: "var-reference",
    futureEligible: false,
    statement: `
var headers = {
  "Content-Type": "application/json"
};

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  },
  {
    id: "authorization-reference",
    futureEligible: false,
    statement: `
const headers = {
  "Content-Type": "application/json",
  "Authorization": "Bearer forbidden"
};

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  },
  {
    id: "dynamic-value-reference",
    futureEligible: false,
    statement: `
const headers = {
  "Content-Type": "application/json",
  "X-API-Version": apiVersion
};

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  },
  {
    id: "template-value-reference",
    futureEligible: false,
    statement: [
      'const headers = {',
      '  "Content-Type": "application/json",',
      '  "X-API-Version": `v${version}`',
      '};',
      '',
      'await fetch(',
      '  "https://api.example.invalid/orders",',
      '  {',
      '    method: "POST",',
      '    headers,',
      '    body: JSON.stringify(payload)',
      '  }',
      ');'
    ].join("\n")
  },
  {
    id: "spread-reference",
    futureEligible: false,
    statement: `
const headers = {
  "Content-Type": "application/json",
  ...extraHeaders
};

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  },
  {
    id: "computed-key-reference",
    futureEligible: false,
    statement: `
const headers = {
  [headerName]: "application/json"
};

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  },
  {
    id: "function-result-reference",
    futureEligible: false,
    statement: `
const headers = makeHeaders();

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  },
  {
    id: "mutated-reference",
    futureEligible: false,
    statement: `
const headers = {
  "Content-Type": "application/json"
};

headers["X-API-Version"] = version;

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  },
  {
    id: "reassigned-property-reference",
    futureEligible: false,
    statement: `
const headers = {
  "Content-Type": "application/json"
};

headers["Content-Type"] = contentType;

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  },
  {
    id: "unresolved-reference",
    futureEligible: false,
    statement: `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  },
  {
    id: "duplicate-declaration-reference",
    futureEligible: false,
    statement: `
const headers = {
  "Content-Type": "application/json"
};

const headers = {
  "X-API-Version": "2026-09-01"
};

await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  }
);`
  }
];

let futureSafe = 0;
let currentlyEligible = 0;

console.log("HTTP STATIC HEADER REFERENCE CONTRACT");
console.log("=====================================");

for (const fixture of cases) {
  const {
    declarations,
    statement
  } = splitFixtureSource(
    fixture.statement
  );

  const fixtureFunctionSource = `
async function createOrder(operationId, payload) {
${declarations}
${statement}
}
`;

  const result = transformHttpWriteV1({
    statement,
    functionSource:
      fixtureFunctionSource,
    operationId:
      `reference-contract-${fixture.id}`,
    provider
  });

  if (fixture.futureEligible) {
    futureSafe += 1;
  }

  if (result.eligible) {
    currentlyEligible += 1;
  }

  console.log(
    `${result.eligible ? "ELIGIBLE" : "REJECTED"}  ` +
    `${fixture.futureEligible ? "FUTURE-SAFE" : "MUST-REJECT"}  ` +
    fixture.id +
    (result.eligible ? "" : `  ${result.reason ?? "<no reason>"}`)
  );

  /*
   * Phase 16E Task 2 intentionally pins only the negative boundary.
   * The three FUTURE-SAFE cases are expected to remain rejected until
   * production transformer behaviour is deliberately changed.
   */
  assert.equal(
    result.eligible,
    fixture.futureEligible,
    fixture.futureEligible
      ? `${fixture.id} should now be safely transformable`
      : `${fixture.id} unexpectedly crossed the fail-closed boundary`
  );
}

assert.equal(cases.length, 15);
assert.equal(futureSafe, 3);

console.log("");
console.log(`Contract fixtures:          ${cases.length}`);
console.log(`Future-safe references:     ${futureSafe}`);
console.log(`Must-remain-rejected:       ${cases.length - futureSafe}`);
console.log(`Currently eligible:         ${currentlyEligible}`);
console.log("");
console.log(
  "PASS - static header reference safety contract pinned without broadening production behaviour"
);

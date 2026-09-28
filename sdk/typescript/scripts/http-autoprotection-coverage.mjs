import assert from "node:assert/strict";
import { transformHttpWriteV1 } from "../dist/transformers/http-write-v1.js";

const functionSource = `
async function consequentialWrite(operationId, payload) {
}
`;

const fixtures = [
  {
    id: "baseline-no-headers",
    category: "supported-baseline",
    expectedEligible: true,
    statement: `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    body: JSON.stringify(payload)
  }
);
`
  },
  {
    id: "baseline-json-content-type",
    category: "supported-baseline",
    expectedEligible: true,
    statement: `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }
);
`
  },
  {
    id: "additional-static-header",
    category: "headers",
    expectedEligible: false,
    statement: `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Version": "2026-09-01"
    },
    body: JSON.stringify(payload)
  }
);
`
  },
  {
    id: "static-authorization",
    category: "headers",
    expectedEligible: false,
    statement: `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers: {
      "Authorization": "Bearer fixed-test-token"
    },
    body: JSON.stringify(payload)
  }
);
`
  },
  {
    id: "dynamic-authorization",
    category: "headers",
    expectedEligible: false,
    statement: `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers: {
      "Authorization": \`Bearer \${token}\`
    },
    body: JSON.stringify(payload)
  }
);
`
  },
  {
    id: "headers-reference",
    category: "headers",
    expectedEligible: false,
    statement: `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers
    ,
    body: JSON.stringify(payload)
  }
);
`
  },
  {
    id: "spread-headers",
    category: "headers",
    expectedEligible: false,
    statement: `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    headers: {
      ...headers
    },
    body: JSON.stringify(payload)
  }
);
`
  },
  {
    id: "dynamic-url",
    category: "URL",
    expectedEligible: false,
    statement: `
await fetch(
  endpoint,
  {
    method: "POST",
    body: JSON.stringify(payload)
  }
);
`
  },
  {
    id: "put",
    category: "method",
    expectedEligible: false,
    statement: `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "PUT",
    body: JSON.stringify(payload)
  }
);
`
  },
  {
    id: "patch",
    category: "method",
    expectedEligible: false,
    statement: `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "PATCH",
    body: JSON.stringify(payload)
  }
);
`
  },
  {
    id: "delete",
    category: "method",
    expectedEligible: false,
    statement: `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "DELETE",
    body: JSON.stringify(payload)
  }
);
`
  },
  {
    id: "raw-body",
    category: "body",
    expectedEligible: false,
    statement: `
await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    body: payload
  }
);
`
  },
  {
    id: "returned-response",
    category: "response",
    expectedEligible: false,
    statement: `
return await fetch(
  "https://api.example.invalid/orders",
  {
    method: "POST",
    body: JSON.stringify(payload)
  }
);
`
  },
  {
    id: "assigned-response",
    category: "response",
    expectedEligible: false,
    statement: `
const response =
  await fetch(
    "https://api.example.invalid/orders",
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
`
  },
  {
    id: "consumed-response",
    category: "response",
    expectedEligible: false,
    statement: `
const result =
  await (
    await fetch(
      "https://api.example.invalid/orders",
      {
        method: "POST",
        body: JSON.stringify(payload)
      }
    )
  ).json();
`
  }
];

const results = fixtures.map((fixture) => {
  const result = transformHttpWriteV1({
    statement: fixture.statement,
    functionSource,
    provider: "customer-http"
  });

  assert.equal(
    result.eligible,
    fixture.expectedEligible,
    [
      fixture.id,
      `expected eligible=${fixture.expectedEligible}`,
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

  return {
    id: fixture.id,
    category: fixture.category,
    eligible: result.eligible,
    intendedSafe: fixture.intendedSafe ?? fixture.expectedEligible,
    knownBaselineAnomaly: fixture.knownBaselineAnomaly ?? false,
    reason: result.eligible ? null : result.reason
  };
});

const total = results.length;
const observedEligible = results.filter((result) => result.eligible).length;
const observedRejected = total - observedEligible;
const intendedSafe = results.filter((result) => result.intendedSafe).length;
const anomalies = results.filter((result) => result.knownBaselineAnomaly);
const observedCoverage = (observedEligible / total) * 100;
const intendedSafeCoverage = (intendedSafe / total) * 100;

assert.equal(total, 15);
assert.equal(observedEligible, 2);
assert.equal(observedRejected, 13);
assert.equal(intendedSafe, 2);
assert.equal(anomalies.length, 0);
assert.equal(observedCoverage.toFixed(2), "13.33");
assert.equal(intendedSafeCoverage.toFixed(2), "13.33");

const rejectionCounts = new Map();
const categoryCounts = new Map();

for (const result of results) {
  categoryCounts.set(
    result.category,
    (categoryCounts.get(result.category) ?? 0) + 1
  );

  if (!result.eligible) {
    rejectionCounts.set(
      result.reason,
      (rejectionCounts.get(result.reason) ?? 0) + 1
    );
  }
}

console.log("");
console.log("HTTP AUTOPROTECTION COVERAGE");
console.log("============================");
console.log(`Total consequential fixtures: ${total}`);
console.log(`Observed transformer-eligible: ${observedEligible}`);
console.log(`Observed rejected:             ${observedRejected}`);
console.log(`Observed eligibility coverage: ${observedCoverage.toFixed(2)}%`);
console.log(`Intended safely transformable: ${intendedSafe}`);
console.log(`Intended safe coverage:        ${intendedSafeCoverage.toFixed(2)}%`);
console.log(`Known baseline anomalies:      ${anomalies.length}`);
console.log("");
console.log("Known baseline anomalies:");
for (const anomaly of anomalies) {
  console.log(`KNOWN ANOMALY  ${anomaly.id}`);
}

console.log("");
console.log("Rejection counts by exact reason:");

for (const [reason, count] of [...rejectionCounts.entries()].sort(
  (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
)) {
  console.log(`${count}  ${reason}`);
}

console.log("");
console.log("Category counts:");

for (const [category, count] of categoryCounts.entries()) {
  console.log(`${category}: ${count}`);
}

console.log("");
console.log("Fixture results:");

for (const result of results) {
  console.log(
    `${result.eligible ? "TRANSFORMABLE" : "REJECTED"}  ${result.id}` +
      (result.reason ? `  ${result.reason}` : "")
  );
}

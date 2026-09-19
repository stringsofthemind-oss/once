import {
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";

import path from "node:path";

import {
  collectSourceFiles,
  scanFile
} from "../dist/scan.js";

const root =
  process.cwd();

const temp =
  path.join(
    root,
    ".scanner-declaration-regression-temp"
  );

await rm(
  temp,
  {
    recursive: true,
    force: true
  }
);

await mkdir(
  path.join(
    temp,
    "src"
  ),
  {
    recursive: true
  }
);

const orderFile =
  path.join(
    temp,
    "src",
    "order.ts"
  );

const callerFile =
  path.join(
    temp,
    "src",
    "caller.ts"
  );

await writeFile(
  orderFile,
  `
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
`.trimStart(),
  "utf8"
);

await writeFile(
  callerFile,
  `
export async function callExisting() {
  await createOrder();
}
`.trimStart(),
  "utf8"
);

const files =
  await collectSourceFiles(
    temp
  );

const findings = [];

for (
  const file of files
) {
  findings.push(
    ...await scanFile(
      temp,
      file
    )
  );
}

const normalized =
  findings.map(
    finding => ({
      ...finding,
      file:
        finding.file
          .replaceAll(
            "\\",
            "/"
          )
    })
  );

const orderFindings =
  normalized.filter(
    finding =>
      finding.file.endsWith(
        "src/order.ts"
      )
  );

const callerFindings =
  normalized.filter(
    finding =>
      finding.file.endsWith(
        "src/caller.ts"
      )
  );

console.log("");
console.log(
  "ONCE SCANNER DECLARATION REGRESSION"
);
console.log(
  "==================================="
);

if (
  orderFindings.length !== 1
) {
  console.error(
    orderFindings
  );

  throw new Error(
    `Expected one finding in order.ts; got ${orderFindings.length}`
  );
}

if (
  orderFindings[0].category !==
  "HTTP_WRITE"
) {
  console.error(
    orderFindings
  );

  throw new Error(
    "Function declaration produced a false consequential-operation finding"
  );
}

console.log(
  "PASS - multiline createOrder declaration ignored"
);

console.log(
  "PASS - real HTTP_WRITE inside function retained"
);

if (
  callerFindings.length !== 1
) {
  console.error(
    callerFindings
  );

  throw new Error(
    `Expected one finding in caller.ts; got ${callerFindings.length}`
  );
}

if (
  callerFindings[0].category !==
  "BOOKING"
) {
  console.error(
    callerFindings
  );

  throw new Error(
    "Real createOrder() invocation was incorrectly suppressed"
  );
}

console.log(
  "PASS - real createOrder() invocation still detected"
);

const declarationBooking =
  orderFindings.some(
    finding =>
      finding.category ===
      "BOOKING"
  );

if (
  declarationBooking
) {
  throw new Error(
    "BOOKING false positive remains on declaration"
  );
}

console.log(
  "PASS - declaration false positive eliminated"
);

await rm(
  temp,
  {
    recursive: true,
    force: true
  }
);

console.log("");
console.log(
  "ONCE SCANNER DECLARATION REGRESSION PASSED"
);
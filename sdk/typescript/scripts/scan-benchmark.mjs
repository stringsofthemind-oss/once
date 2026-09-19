import {
  spawnSync
} from "node:child_process";

import {
  existsSync
} from "node:fs";

import path from "node:path";

const root =
  process.cwd();

const cli =
  path.join(
    root,
    "dist",
    "cli.js"
  );

const suites = [
  {
    name: "V1 baseline",
    directory:
      "scan-torture-v1",

    risky: [
      "src/booking.ts",
      "src/database.ts",
      "src/delete.ts",
      "src/email.ts",
      "src/payment.ts",
      "src/post.ts",
      "src/queue.ts",
      "src/file.ts"
    ]
  },

  {
    name: "V2 adversarial",
    directory:
      "scan-torture-v2",

    risky: [
      "src/stripe.ts",
      "src/slack.ts",
      "src/prisma.ts",
      "src/supabase.ts",
      "src/axios-alias.ts",
      "src/python-post.py",
      "src/aws.ts",
      "src/github.ts",
      "src/producer.ts"
    ]
  }
];

function normalize(
  value
) {
  return value
    .replaceAll("\\", "/")
    .toLowerCase();
}

function percent(
  numerator,
  denominator
) {
  if (denominator === 0) {
    return 100;
  }

  return (
    numerator /
    denominator *
    100
  );
}

function runSuite(
  suite
) {

  const fixture =
    path.join(
      root,
      suite.directory
    );

  if (
    !existsSync(
      fixture
    )
  ) {
    throw new Error(
      `Missing fixture: ${fixture}`
    );
  }

  const result =
    spawnSync(
      process.execPath,
      [
        cli,
        "scan",
        fixture,
        "--no-estimate"
      ],
      {
        cwd: root,
        encoding: "utf8"
      }
    );

  if (
    result.status !== 0
  ) {
    console.error(
      result.stdout
    );

    console.error(
      result.stderr
    );

    throw new Error(
      `${suite.name} scanner process failed`
    );
  }

  const matches =
    [
      ...result.stdout.matchAll(
        /^(src[\\/][^:\r\n]+):\d+/gm
      )
    ];

  const rawFindings =
    matches.map(
      match =>
        normalize(
          match[1]
        )
    );

  const found =
    new Set(
      rawFindings
    );

  const expected =
    new Set(
      suite.risky.map(
        normalize
      )
    );

  const truePositives =
    [...expected].filter(
      file =>
        found.has(file)
    );

  const falseNegatives =
    [...expected].filter(
      file =>
        !found.has(file)
    );

  const falsePositives =
    [...found].filter(
      file =>
        !expected.has(file)
    );

  const duplicateNoise =
    rawFindings.length -
    found.size;

  const precision =
    percent(
      truePositives.length,
      truePositives.length +
      falsePositives.length
    );

  const recall =
    percent(
      truePositives.length,
      truePositives.length +
      falseNegatives.length
    );

  const f1 =
    precision + recall === 0
      ? 0
      : (
          2 *
          precision *
          recall /
          (
            precision +
            recall
          )
        );

  return {
    suite:
      suite.name,

    expected:
      expected.size,

    raw:
      rawFindings.length,

    unique:
      found.size,

    tp:
      truePositives.length,

    fp:
      falsePositives,

    fn:
      falseNegatives,

    duplicateNoise,

    precision,

    recall,

    f1
  };
}

console.log("");
console.log(
  "ONCE SCAN BENCHMARK"
);
console.log(
  "==================="
);

const results =
  suites.map(
    runSuite
  );

let totalExpected = 0;
let totalTp = 0;
let totalFp = 0;
let totalFn = 0;
let totalNoise = 0;

let failed = false;

for (
  const result
  of results
) {

  totalExpected +=
    result.expected;

  totalTp +=
    result.tp;

  totalFp +=
    result.fp.length;

  totalFn +=
    result.fn.length;

  totalNoise +=
    result.duplicateNoise;

  console.log("");
  console.log(
    result.suite
  );

  console.log(
    "-".repeat(
      result.suite.length
    )
  );

  console.log(
    `Expected risky: ${result.expected}`
  );

  console.log(
    `True positives: ${result.tp}`
  );

  console.log(
    `False positives: ${result.fp.length}`
  );

  console.log(
    `False negatives: ${result.fn.length}`
  );

  console.log(
    `Duplicate/noise findings: ${result.duplicateNoise}`
  );

  console.log(
    `Precision: ${result.precision.toFixed(1)}%`
  );

  console.log(
    `Recall: ${result.recall.toFixed(1)}%`
  );

  console.log(
    `F1: ${result.f1.toFixed(1)}%`
  );

  if (
    result.fp.length > 0
  ) {
    console.log(
      "Unexpected findings:"
    );

    for (
      const file
      of result.fp
    ) {
      console.log(
        `  + ${file}`
      );
    }
  }

  if (
    result.fn.length > 0
  ) {
    console.log(
      "Missed operations:"
    );

    for (
      const file
      of result.fn
    ) {
      console.log(
        `  - ${file}`
      );
    }
  }

  if (
    result.fp.length > 0 ||
    result.fn.length > 0 ||
    result.duplicateNoise > 0
  ) {
    failed = true;
  }
}

const combinedPrecision =
  percent(
    totalTp,
    totalTp + totalFp
  );

const combinedRecall =
  percent(
    totalTp,
    totalTp + totalFn
  );

const combinedF1 =
  combinedPrecision +
    combinedRecall ===
  0
    ? 0
    : (
        2 *
        combinedPrecision *
        combinedRecall /
        (
          combinedPrecision +
          combinedRecall
        )
      );

console.log("");
console.log(
  "COMBINED"
);
console.log(
  "--------"
);

console.log(
  `Expected risky: ${totalExpected}`
);

console.log(
  `True positives: ${totalTp}`
);

console.log(
  `False positives: ${totalFp}`
);

console.log(
  `False negatives: ${totalFn}`
);

console.log(
  `Duplicate/noise findings: ${totalNoise}`
);

console.log(
  `Precision: ${combinedPrecision.toFixed(1)}%`
);

console.log(
  `Recall: ${combinedRecall.toFixed(1)}%`
);

console.log(
  `F1: ${combinedF1.toFixed(1)}%`
);

console.log("");

if (failed) {

  console.log(
    "ONCE SCAN BENCHMARK FAILED"
  );

  process.exit(1);
}

console.log(
  "ONCE SCAN BENCHMARK PASSED"
);

console.log(
  "All controlled consequential operations detected."
);

console.log(
  "No controlled safe files flagged."
);
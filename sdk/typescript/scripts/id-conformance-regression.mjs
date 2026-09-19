import {
  createHash
} from "node:crypto";

import {
  readFileSync
} from "node:fs";

import {
  spawnSync
} from "node:child_process";

import {
  dirname,
  join,
  resolve
} from "node:path";

import {
  fileURLToPath
} from "node:url";

import {
  Once
} from "../dist/index.js";


const here =
  dirname(
    fileURLToPath(
      import.meta.url
    )
  );

const sdkRoot =
  resolve(
    here,
    ".."
  );

const projectRoot =
  resolve(
    sdkRoot,
    "..",
    ".."
  );

const vectorFile =
  join(
    projectRoot,
    "conformance",
    "once-id-v1-vectors.json"
  );

const shaFile =
  vectorFile + ".sha256";


function fail(message) {

  console.error(
    "FAIL -",
    message
  );

  process.exit(1);
}


console.log(
  "===== ONCE.ID V1 SPEC INTEGRITY ====="
);

const vectorBytes =
  readFileSync(
    vectorFile
  );

const actualSha =
  createHash("sha256")
    .update(vectorBytes)
    .digest("hex");

const expectedSha =
  readFileSync(
    shaFile,
    "ascii"
  )
    .trim()
    .split(/\s+/)[0];

if (
  actualSha !==
  expectedSha
) {
  fail(
    "frozen vector SHA256 mismatch"
  );
}

console.log(
  "PASS - frozen vector SHA256:",
  actualSha
);


const spec =
  JSON.parse(
    vectorBytes.toString(
      "utf8"
    )
  );

if (
  spec.spec !==
  "once-id-v1"
) {
  fail(
    "unexpected spec identifier"
  );
}


console.log();
console.log(
  "===== TYPESCRIPT CONFORMANCE ====="
);


for (
  const vector
  of spec.valid
) {

  let actual;

  try {

    actual =
      Once.id(
        ...vector.parts
      );

  } catch (error) {

    fail(
      `TypeScript valid vector threw: ${vector.name}: ${
        error?.message ?? error
      }`
    );
  }

  if (
    actual !==
    vector.expected_id
  ) {

    fail(
      `TypeScript mismatch: ${vector.name}\n` +
      `expected: ${vector.expected_id}\n` +
      `actual:   ${actual}`
    );
  }
}


for (
  const vector
  of spec.invalid
) {

  let rejected =
    false;

  try {

    Once.id(
      ...vector.parts
    );

  } catch (error) {

    rejected =
      true;

    if (
      error?.code !==
      vector.expected_error_code
    ) {

      fail(
        `TypeScript wrong error code: ${vector.name}: ${
          error?.code
        }`
      );
    }
  }

  if (
    !rejected
  ) {

    fail(
      `TypeScript accepted invalid vector: ${
        vector.name
      }`
    );
  }
}


const tsCollisionA =
  Once.id(
    "order",
    "a\u001fb"
  );

const tsCollisionB =
  Once.id(
    "order",
    "a",
    "b"
  );

if (
  tsCollisionA ===
  tsCollisionB
) {

  fail(
    "TypeScript separator collision regression"
  );
}


console.log(
  "PASS - TypeScript valid vectors:",
  spec.valid.length
);

console.log(
  "PASS - TypeScript invalid vectors:",
  spec.invalid.length
);

console.log(
  "PASS - TypeScript collision regression"
);


console.log();
console.log(
  "===== PYTHON CONFORMANCE ====="
);


const pythonCode = String.raw`
import json
import sys
from pathlib import Path

root = Path(
    sys.argv[1]
)

vectors_path = Path(
    sys.argv[2]
)

sys.path.insert(
    0,
    str(
        root /
        "sdk" /
        "python" /
        "src"
    )
)

from once_agent import Once
from once_agent import OnceError

spec = json.loads(
    vectors_path.read_text(
        encoding="utf-8"
    )
)

for vector in spec["valid"]:

    actual = Once.id(
        *vector["parts"]
    )

    if actual != vector["expected_id"]:
        raise SystemExit(
            "Python mismatch: "
            + vector["name"]
            + "\nexpected: "
            + vector["expected_id"]
            + "\nactual:   "
            + actual
        )

for vector in spec["invalid"]:

    try:
        Once.id(
            *vector["parts"]
        )

    except OnceError as error:

        if error.code != vector["expected_error_code"]:
            raise SystemExit(
                "Python wrong error code: "
                + vector["name"]
            )

    else:
        raise SystemExit(
            "Python accepted invalid vector: "
            + vector["name"]
        )

a = Once.id(
    "order",
    "a\x1fb",
)

b = Once.id(
    "order",
    "a",
    "b",
)

if a == b:
    raise SystemExit(
        "Python separator collision regression"
    )

print(
    "PASS - Python valid vectors:",
    len(spec["valid"])
)

print(
    "PASS - Python invalid vectors:",
    len(spec["invalid"])
)

print(
    "PASS - Python collision regression"
)
`;


const python =
  spawnSync(
    "python",
    [
      "-c",
      pythonCode,
      projectRoot,
      vectorFile
    ],
    {
      cwd:
        projectRoot,

      encoding:
        "utf8"
    }
  );


if (
  python.stdout
) {

  process.stdout.write(
    python.stdout
  );
}


if (
  python.stderr
) {

  process.stderr.write(
    python.stderr
  );
}


if (
  python.error
) {

  fail(
    `Python launch failed: ${
      python.error.message
    }`
  );
}


if (
  python.status !== 0
) {

  fail(
    `Python conformance exited ${
      python.status
    }`
  );
}


console.log();
console.log(
  "PASS - TypeScript and Python match frozen Once.id v1"
);

console.log(
  "PASS - frozen specification integrity verified"
);

console.log(
  "ONCE ID V1 PERMANENT REGRESSION PASSED"
);
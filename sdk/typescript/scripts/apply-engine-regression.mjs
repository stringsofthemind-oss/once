import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";

import {
  spawnSync
} from "node:child_process";

import path from "node:path";

import {
  applyProtectionPlan
} from "../dist/apply.js";

const root =
  process.cwd();

const cli =
  path.join(
    root,
    "dist",
    "cli.js"
  );

const tempRoot =
  path.join(
    root,
    ".apply-engine-regression-temp"
  );

async function createFixture(
  name,
  extraSource = ""
) {

  const directory =
    path.join(
      tempRoot,
      name
    );

  await rm(
    directory,
    {
      recursive: true,
      force: true
    }
  );

  await mkdir(
    path.join(
      directory,
      "src"
    ),
    {
      recursive: true
    }
  );

  await mkdir(
    path.join(
      directory,
      ".once"
    ),
    {
      recursive: true
    }
  );

  const source = `
export async function sendOrder(
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

${extraSource}
`.trimStart();

  const sourcePath =
    path.join(
      directory,
      "src",
      "order.ts"
    );

  await writeFile(
    sourcePath,
    source,
    "utf8"
  );

  await writeFile(
    path.join(
      directory,
      ".once",
      "config.json"
    ),
    JSON.stringify(
      {
        version: 1,

        provider: {
          name:
            "apply-engine-test-provider",

          type:
            "http_v1",

          version_id:
            "pv_00000000000000000000000000000000"
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(
      directory,
      ".once",
      "provider-capabilities.json"
    ),
    JSON.stringify(
      {
        schema_version: 1,

        provider:
          "apply-engine-test-provider",

        capabilities: [
          {
            category:
              "HTTP_WRITE",

            action_type:
              "http_write_v1",

            allowed_urls: [
              "https://api.example.invalid/orders"

            ]
          }
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  return {
    directory,
    source,
    sourcePath
  };
}

function createPlan(
  directory
) {

  const result =
    spawnSync(
      process.execPath,
      [
        cli,
        "protect",
        directory,
        "--all",
        "--write-plan"
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
      "Could not generate Protect plan"
    );
  }

  if (
    !result.stdout.includes(
      "PATCHABLE"
    )
  ) {
    console.error(
      result.stdout
    );

    throw new Error(
      "Fixture did not become PATCHABLE"
    );
  }
}

await rm(
  tempRoot,
  {
    recursive: true,
    force: true
  }
);

await mkdir(
  tempRoot,
  {
    recursive: true
  }
);

console.log("");
console.log(
  "ONCE APPLY ENGINE REGRESSION"
);

console.log(
  "============================"
);

//
// TEST 1 — SUCCESSFUL APPLY
//

const success =
  await createFixture(
    "success"
  );

createPlan(
  success.directory
);

const beforeApply =
  await readFile(
    success.sourcePath,
    "utf8"
  );

if (
  beforeApply !==
  success.source
) {
  throw new Error(
    "Protect planning unexpectedly modified source"
  );
}

console.log(
  "PASS - planning left source untouched"
);

const appliedResult =
  await applyProtectionPlan(
    success.directory
  );

const appliedSource =
  await readFile(
    success.sourcePath,
    "utf8"
  );

if (
  !appliedSource.includes(
    'import { Once as __OnceAgentClient } from "@once-agent/sdk";'
  )
) {
  throw new Error(
    "Once SDK import missing after apply"
  );
}

if (
  !appliedSource.includes(
    "await new __OnceAgentClient().execute("
  )
) {
  throw new Error(
    "Once execution missing after apply"
  );
}

if (
  appliedSource.includes(
    "await fetch("
  )
) {
  throw new Error(
    "Original fetch remains after apply"
  );
}

console.log(
  "PASS - PATCHABLE source transformed"
);

console.log(
  "PASS - original fetch removed"
);

console.log(
  "PASS - Once execution inserted"
);

const backupSource =
  await readFile(
    appliedResult.backupPath,
    "utf8"
  );

if (
  backupSource !==
  success.source
) {
  throw new Error(
    "Backup does not exactly match original source"
  );
}

console.log(
  "PASS - exact original source backed up"
);

//
// TEST 2 — STALE PLAN
//

const stale =
  await createFixture(
    "stale"
  );

createPlan(
  stale.directory
);

const changedSource =
  (
    await readFile(
      stale.sourcePath,
      "utf8"
    )
  ) +
  "\n// customer edit after planning\n";

await writeFile(
  stale.sourcePath,
  changedSource,
  "utf8"
);

let staleRejected =
  false;

try {

  await applyProtectionPlan(
    stale.directory
  );

} catch (error) {

  staleRejected =
    String(
      error
    ).includes(
      "Source changed after Protect planning"
    );
}

if (!staleRejected) {
  throw new Error(
    "Stale Protect plan was not rejected"
  );
}

const staleAfter =
  await readFile(
    stale.sourcePath,
    "utf8"
  );

if (
  staleAfter !==
  changedSource
) {
  throw new Error(
    "Stale-plan rejection modified customer source"
  );
}

console.log(
  "PASS - stale source hash rejected"
);

console.log(
  "PASS - stale customer source left untouched"
);

//
// TEST 3 — COMPILER FAILURE
//

const broken =
  await createFixture(
    "broken",
    "const deliberatelyBroken = ;"
  );

createPlan(
  broken.directory
);

const brokenBefore =
  await readFile(
    broken.sourcePath,
    "utf8"
  );

let compilerRejected =
  false;

try {

  await applyProtectionPlan(
    broken.directory
  );

} catch (error) {

  compilerRejected =
    String(
      error
    ).includes(
      "TypeScript verification failed"
    );
}

if (!compilerRejected) {
  throw new Error(
    "Invalid TypeScript was not rejected"
  );
}

const brokenAfter =
  await readFile(
    broken.sourcePath,
    "utf8"
  );

if (
  brokenAfter !==
  brokenBefore
) {
  throw new Error(
    "Compiler failure changed original source"
  );
}

console.log(
  "PASS - TypeScript verification failure rejected"
);

console.log(
  "PASS - compiler failure preserved original source"
);

//
// No temporary files should remain.
//

async function findTempFiles(
  directory
) {

  const found =
    [];

  async function walk(
    current
  ) {

    const entries =
      await readdir(
        current,
        {
          withFileTypes: true
        }
      );

    for (
      const entry
      of entries
    ) {

      const full =
        path.join(
          current,
          entry.name
        );

      if (
        entry.isDirectory()
      ) {

        await walk(
          full
        );

        continue;
      }

      if (
        entry.name.startsWith(
          ".once-"
        ) &&
        entry.name.endsWith(
          ".tmp"
        )
      ) {
        found.push(
          full
        );
      }
    }
  }

  await walk(
    directory
  );

  return found;
}

const leftovers =
  await findTempFiles(
    tempRoot
  );

if (
  leftovers.length !== 0
) {

  console.error(
    leftovers
  );

  throw new Error(
    "Temporary apply files were left behind"
  );
}

console.log(
  "PASS - no temporary patch files left behind"
);

await rm(
  tempRoot,
  {
    recursive: true,
    force: true
  }
);

console.log("");
console.log(
  "ONCE APPLY ENGINE REGRESSION PASSED"
);
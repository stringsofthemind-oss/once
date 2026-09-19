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
    ".cli-apply-regression-temp"
  );

async function writeJson(
  file,
  value
) {

  await writeFile(
    file,
    JSON.stringify(
      value,
      null,
      2
    ) + "\n",
    "utf8"
  );
}

async function createProject(
  name,
  source
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

  await writeJson(
    path.join(
      directory,
      ".once",
      "config.json"
    ),
    {
      version: 1,

      provider: {
        name:
          "cli-regression-provider",

        type:
          "http_v1",

        version_id:
          "pv_00000000000000000000000000000000"
      }
    }
  );

  await writeJson(
    path.join(
      directory,
      ".once",
      "provider-capabilities.json"
    ),
    {
      schema_version: 1,

      provider:
        "cli-regression-provider",

      capabilities: [
        {
          category:
            "HTTP_WRITE",

          action_type:
            "http_write_v1",

          allowed_urls: [
            "https://api.example.invalid/orders",
            "https://api.example.invalid/invoices"

          ]
        }
      ]
    }
  );

  return {
    directory,
    sourcePath,
    source
  };
}

function runApply(
  directory
) {

  return spawnSync(
    process.execPath,
    [
      cli,
      "protect",
      directory,
      "--apply"
    ],
    {
      cwd: root,
      encoding: "utf8"
    }
  );
}

const oneCandidateSource = `
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

const zeroCandidateSource = `
export async function readOrder() {
  return "safe read";
}
`.trimStart();

const twoCandidateSource = `
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

export async function createInvoice(
  operationId: string,
  payload: unknown
) {
  await fetch(
    "https://api.example.invalid/invoices",
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );
}
`.trimStart();

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
  "ONCE PUBLIC CLI APPLY REGRESSION"
);

console.log(
  "================================"
);

//
// CASE 1:
// exactly one PATCHABLE candidate
//

const success =
  await createProject(
    "success",
    oneCandidateSource
  );

const successResult =
  runApply(
    success.directory
  );

if (
  successResult.status !== 0
) {

  console.error(
    successResult.stdout
  );

  console.error(
    successResult.stderr
  );

  throw new Error(
    "Exactly-one PATCHABLE CLI apply failed"
  );
}

const applied =
  await readFile(
    success.sourcePath,
    "utf8"
  );

if (
  !applied.includes(
    'import { Once as __OnceAgentClient } from "@once-agent/sdk";'
  )
) {
  throw new Error(
    "Once SDK import missing"
  );
}

if (
  !applied.includes(
    "await new __OnceAgentClient().execute("
  )
) {
  throw new Error(
    "Once execution missing"
  );
}

if (
  applied.includes(
    "await fetch("
  )
) {
  throw new Error(
    "Original fetch remains"
  );
}

if (
  !successResult.stdout.includes(
    "ONCE PROTECTION APPLIED"
  )
) {
  throw new Error(
    "CLI success confirmation missing"
  );
}

console.log(
  "PASS - exactly one PATCHABLE candidate applied"
);

console.log(
  "PASS - public CLI generated Once-protected source"
);

const backupRoot =
  path.join(
    success.directory,
    ".once",
    "backups"
  );

const backupDirectories =
  await readdir(
    backupRoot
  );

if (
  backupDirectories.length !== 1
) {
  throw new Error(
    "Expected one backup callsite directory"
  );
}

const backupFiles =
  await readdir(
    path.join(
      backupRoot,
      backupDirectories[0]
    )
  );

if (
  backupFiles.length !== 1
) {
  throw new Error(
    "Expected one backup file"
  );
}

const backup =
  await readFile(
    path.join(
      backupRoot,
      backupDirectories[0],
      backupFiles[0]
    ),
    "utf8"
  );

if (
  backup !==
  oneCandidateSource
) {
  throw new Error(
    "Backup differs from exact original"
  );
}

console.log(
  "PASS - exact original source backed up"
);

//
// CASE 2:
// zero PATCHABLE candidates must fail
//

const zero =
  await createProject(
    "zero",
    zeroCandidateSource
  );

const zeroResult =
  runApply(
    zero.directory
  );

if (
  zeroResult.status === 0
) {
  throw new Error(
    "CLI unexpectedly allowed zero PATCHABLE candidates"
  );
}

const zeroAfter =
  await readFile(
    zero.sourcePath,
    "utf8"
  );

if (
  zeroAfter !==
  zeroCandidateSource
) {
  throw new Error(
    "Zero-candidate failure modified source"
  );
}

const zeroOutput =
  (
    zeroResult.stdout +
    zeroResult.stderr
  );

if (
  !zeroOutput.includes(
    "exactly one PATCHABLE candidate"
  )
) {
  console.error(
    zeroOutput
  );

  throw new Error(
    "Zero-candidate failure reason was not explicit"
  );
}

console.log(
  "PASS - zero PATCHABLE candidates rejected"
);

console.log(
  "PASS - zero-candidate source untouched"
);

//
// CASE 3:
// more than one PATCHABLE candidate must fail
//

const multiple =
  await createProject(
    "multiple",
    twoCandidateSource
  );

const multipleResult =
  runApply(
    multiple.directory
  );

if (
  multipleResult.status === 0
) {
  throw new Error(
    "CLI unexpectedly allowed multiple PATCHABLE candidates"
  );
}

const multipleAfter =
  await readFile(
    multiple.sourcePath,
    "utf8"
  );

if (
  multipleAfter !==
  twoCandidateSource
) {
  throw new Error(
    "Multiple-candidate failure modified source"
  );
}

const multipleOutput =
  (
    multipleResult.stdout +
    multipleResult.stderr
  );

if (
  !multipleOutput.includes(
    "exactly one PATCHABLE candidate"
  )
) {
  console.error(
    multipleOutput
  );

  throw new Error(
    "Multiple-candidate failure reason was not explicit"
  );
}

console.log(
  "PASS - multiple PATCHABLE candidates rejected"
);

console.log(
  "PASS - multiple-candidate source untouched"
);

//
// Ensure no temp patch files survive anywhere.
//

const leftovers =
  [];

async function walk(
  directory
) {

  const entries =
    await readdir(
      directory,
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
        directory,
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
      leftovers.push(
        full
      );
    }
  }
}

await walk(
  tempRoot
);

if (
  leftovers.length !== 0
) {

  console.error(
    leftovers
  );

  throw new Error(
    "Temporary patch files remain"
  );
}

console.log(
  "PASS - no temporary apply files remain"
);

await rm(
  tempRoot,
  {
    recursive: true,
    force: true
  }
);

console.log(
  "PASS - disposable regression projects removed"
);

console.log("");
console.log(
  "ONCE PUBLIC CLI APPLY REGRESSION PASSED"
);
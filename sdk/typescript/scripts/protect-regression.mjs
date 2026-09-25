import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";

import {
  createHash
} from "node:crypto";

import {
  spawnSync
} from "node:child_process";

import path from "node:path";

const root =
  process.cwd();

const fixture =
  path.join(
    root,
    "scan-torture-v2"
  );

const temp =
  path.join(
    root,
    ".protect-regression-temp"
  );

const cli =
  path.join(
    root,
    "dist",
    "cli.js"
  );

function sha256(
  value
) {
  return createHash(
    "sha256"
  )
    .update(value)
    .digest("hex");
}

async function collectSourceHashes(
  directory
) {

  const result =
    new Map();

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
        await walk(full);
        continue;
      }

      if (
        !entry.isFile()
      ) {
        continue;
      }

      const relative =
        path
          .relative(
            directory,
            full
          )
          .replaceAll(
            "\\",
            "/"
          );

      const content =
        await readFile(full);

      result.set(
        relative,
        sha256(content)
      );
    }
  }

  await walk(
    path.join(
      directory,
      "src"
    )
  );

  return result;
}

function runProtect(
  args
) {

  const result =
    spawnSync(
      process.execPath,
      [
        cli,
        "protect",
        temp,
        "--all",
        ...args
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
      `Protect command failed: ${args.join(" ")}`
    );
  }

  return result.stdout;
}

function compareHashes(
  before,
  after
) {

  if (
    before.size !==
    after.size
  ) {
    return false;
  }

  for (
    const [
      file,
      hash
    ]
    of before
  ) {

    if (
      after.get(file) !==
      hash
    ) {
      return false;
    }
  }

  return true;
}

await rm(
  temp,
  {
    recursive: true,
    force: true
  }
);

await cp(
  fixture,
  temp,
  {
    recursive: true
  }
);

await mkdir(
  path.join(
    temp,
    ".once"
  ),
  {
    recursive: true
  }
);

await writeFile(
  path.join(
    temp,
    ".once",
    "config.json"
  ),
  JSON.stringify(
    {
      version: 1,
      api_base:
        "https://once.invalid",
      provider: {
        name:
          "protect-test-provider",
        type:
          "http_v1",
        base_url:
          "https://provider.invalid",
        version_id:
          "pv_00000000000000000000000000000000"
      }
    },
    null,
    2
  ) + "\n",
  "utf8"
);

const before =
  await collectSourceHashes(
    temp
  );

console.log("");
console.log(
  "ONCE PROTECT REGRESSION"
);
console.log(
  "======================="
);

runProtect([
  "--write-plan"
]);

const plan =
  JSON.parse(
    await readFile(
      path.join(
        temp,
        ".once",
        "protect-plan.json"
      ),
      "utf8"
    )
  );

if (
  plan.schema_version !== 1
) {
  throw new Error(
    "Unexpected protect-plan schema version"
  );
}

if (
  plan.provider !==
  "protect-test-provider"
) {
  throw new Error(
    "Provider was not preserved in protect plan"
  );
}

if (
  plan.source_modified !==
  false
) {
  throw new Error(
    "Protect plan claims source modification"
  );
}

if (
  !Array.isArray(
    plan.candidates
  ) ||
  plan.candidates.length !== 9
) {
  throw new Error(
    "Expected exactly 9 protect-plan candidates"
  );
}

for (
  const candidate
  of plan.candidates
) {

  if (
    !candidate.callsite_ref ||
    !String(
      candidate.callsite_ref
    ).startsWith("cs_")
  ) {
    throw new Error(
      "Candidate callsite reference missing"
    );
  }

  if (
    !String(
      candidate.runtime_operation_id_rule
    ).includes(
      "stable operationId"
    )
  ) {
    throw new Error(
      "Candidate operationId safety rule missing"
    );
  }
}

console.log(
  "PASS - structured plan: 9 candidates"
);

runProtect([
  "--patch"
]);

const patch =
  await readFile(
    path.join(
      temp,
      ".once",
      "protect-preview.diff"
    ),
    "utf8"
  );

const patchCandidates =
  (
    patch.match(
      /Once protection candidate:/g
    ) ??
    []
  ).length;

if (
  patchCandidates !== 9
) {
  throw new Error(
    `Expected 9 patch candidates, got ${patchCandidates}`
  );
}

if (
  !patch.includes(
    "Runtime operationId must be stable"
  )
) {
  throw new Error(
    "Patch operationId warning missing"
  );
}

console.log(
  "PASS - patch preview: 9 candidates"
);

runProtect([
  "--snippets"
]);

const snippetDirectory =
  path.join(
    temp,
    ".once",
    "protect-snippets"
  );

const snippetFiles =
  (
    await readdir(
      snippetDirectory,
      {
        withFileTypes: true
      }
    )
  ).filter(
    entry =>
      entry.isFile()
  );

if (
  snippetFiles.length !== 9
) {
  throw new Error(
    `Expected 9 snippets, got ${snippetFiles.length}`
  );
}

for (
  const entry
  of snippetFiles
) {

  const content =
    await readFile(
      path.join(
        snippetDirectory,
        entry.name
      ),
      "utf8"
    );

  if (
    !content.includes(
      "stable operationId"
    )
  ) {
    throw new Error(
      `Stable operationId rule missing from ${entry.name}`
    );
  }

  if (
    !content.includes(
      "Do not replace the original call"
    )
  ) {
    throw new Error(
      `Source-replacement warning missing from ${entry.name}`
    );
  }

  if (
    content.includes("Automation: ADAPTER_REQUIRED") &&
    (!content.includes("controlled first proof with a fake effect") ||
      !content.includes("not a production") ||
      !content.includes("does not coordinate separate hosts"))
  ) {
    throw new Error(
      `Adapter safety path missing from ${entry.name}`
    );
  }

  if (
    !content.includes(
      'provider: "protect-test-provider"'
    )
  ) {
    throw new Error(
      `Configured provider missing from ${entry.name}`
    );
  }
}

console.log(
  "PASS - snippets: 9 generated"
);

const after =
  await collectSourceHashes(
    temp
  );

if (
  !compareHashes(
    before,
    after
  )
) {
  throw new Error(
    "Protect modified application source"
  );
}

console.log(
  "PASS - application source unchanged"
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
  "ONCE PROTECT REGRESSION PASSED"
);

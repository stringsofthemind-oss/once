import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";

import {
  spawnSync
} from "node:child_process";

import {
  createHash
} from "node:crypto";

import path from "node:path";

const root =
  process.cwd();

const cli =
  path.join(
    root,
    "dist",
    "cli.js"
  );

const fixture =
  path.join(
    root,
    "scan-torture-v2"
  );

const temp =
  path.join(
    root,
    ".capability-regression-temp"
  );

const onceDir =
  path.join(
    temp,
    ".once"
  );

const manifestPath =
  path.join(
    onceDir,
    "provider-capabilities.json"
  );

const planPath =
  path.join(
    onceDir,
    "protect-plan.json"
  );

function hash(
  value
) {
  return createHash(
    "sha256"
  )
    .update(value)
    .digest("hex");
}

async function sourceHash() {

  const { readdir } =
    await import(
      "node:fs/promises"
    );

  const files = [];

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
        await walk(full);
      } else if (
        entry.isFile()
      ) {
        files.push(full);
      }
    }
  }

  await walk(
    path.join(
      temp,
      "src"
    )
  );

  files.sort();

  const combined = [];

  for (
    const file
    of files
  ) {
    combined.push(
      path.relative(
        temp,
        file
      )
    );

    combined.push(
      await readFile(
        file
      )
    );
  }

  return hash(
    Buffer.concat(
      combined.map(
        value =>
          Buffer.isBuffer(value)
            ? value
            : Buffer.from(
                String(value)
              )
      )
    )
  );
}

function runProtect() {

  const result =
    spawnSync(
      process.execPath,
      [
        cli,
        "protect",
        temp,
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
      "Protect capability regression command failed"
    );
  }

  return result.stdout;
}

async function readPlan() {

  return JSON.parse(
    await readFile(
      planPath,
      "utf8"
    )
  );
}

function assertPlan(
  plan,
  expectedDeclared,
  expectedAdapter
) {

  const declared =
    plan.candidates.filter(
      candidate =>
        candidate.automation_status ===
        "PROVIDER_CAPABILITY_DECLARED"
    );

  const adapters =
    plan.candidates.filter(
      candidate =>
        candidate.automation_status ===
        "ADAPTER_REQUIRED"
    );

  const mapping =
    plan.candidates.filter(
      candidate =>
        candidate.automation_status ===
        "PROVIDER_MAPPING_REQUIRED"
    );

  const autoEligible =
    plan.candidates.filter(
      candidate =>
        candidate.auto_apply_eligible ===
        true
    );

  if (
    declared.length !==
    expectedDeclared
  ) {
    throw new Error(
      `Expected ${expectedDeclared} declared capabilities; got ${declared.length}`
    );
  }

  if (
    adapters.length !==
    expectedAdapter
  ) {
    throw new Error(
      `Expected ${expectedAdapter} adapter-required findings; got ${adapters.length}`
    );
  }

  if (
    autoEligible.length !== 0
  ) {
    throw new Error(
      "Capability manifest incorrectly enabled auto-apply"
    );
  }

  return {
    declared:
      declared.length,
    mapping:
      mapping.length
  };
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
  onceDir,
  {
    recursive: true
  }
);

await writeFile(
  path.join(
    onceDir,
    "config.json"
  ),
  JSON.stringify(
    {
      version: 1,
      provider: {
        name:
          "capability-test-provider",
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

const before =
  await sourceHash();

const validManifest =
  JSON.stringify(
    {
      schema_version: 1,
      provider:
        "capability-test-provider",
      capabilities: [
        {
          category:
            "HTTP_WRITE",
          action_type:
            "http_write_v1"
        }
      ]
    },
    null,
    2
  ) + "\n";

console.log("");
console.log(
  "ONCE CAPABILITY REGRESSION"
);
console.log(
  "=========================="
);

//
// Plain UTF-8
//

await writeFile(
  manifestPath,
  validManifest,
  "utf8"
);

let output =
  runProtect();

if (
  !output.includes(
    "Capability manifest: loaded"
  )
) {
  throw new Error(
    "Plain UTF-8 manifest was not loaded"
  );
}

let result =
  assertPlan(
    await readPlan(),
    2,
    7
  );

if (
  result.mapping !== 0
) {
  throw new Error(
    "HTTP_WRITE remained unmapped despite declared capability"
  );
}

console.log(
  "PASS - UTF-8 manifest without BOM"
);

//
// UTF-8 BOM
//

await writeFile(
  manifestPath,
  "\uFEFF" +
    validManifest,
  "utf8"
);

output =
  runProtect();

if (
  !output.includes(
    "Capability manifest: loaded"
  )
) {
  throw new Error(
    "UTF-8 BOM manifest was not loaded"
  );
}

result =
  assertPlan(
    await readPlan(),
    2,
    7
  );

console.log(
  "PASS - UTF-8 manifest with BOM"
);

//
// Wrong provider must not be trusted
//

await writeFile(
  manifestPath,
  JSON.stringify(
    {
      schema_version: 1,
      provider:
        "different-provider",
      capabilities: [
        {
          category:
            "HTTP_WRITE",
          action_type:
            "http_write_v1"
        }
      ]
    },
    null,
    2
  ),
  "utf8"
);

output =
  runProtect();

if (
  !output.includes(
    "Capability manifest: not present"
  )
) {
  throw new Error(
    "Provider-mismatched manifest was not rejected"
  );
}

const mismatchPlan =
  await readPlan();

const mappingRequired =
  mismatchPlan.candidates.filter(
    candidate =>
      candidate.automation_status ===
      "PROVIDER_MAPPING_REQUIRED"
  );

const mismatchEligible =
  mismatchPlan.candidates.filter(
    candidate =>
      candidate.auto_apply_eligible ===
      true
  );

if (
  mappingRequired.length !== 2
) {
  throw new Error(
    "Provider-mismatched manifest affected HTTP mapping"
  );
}

if (
  mismatchEligible.length !== 0
) {
  throw new Error(
    "Provider-mismatched manifest enabled auto-apply"
  );
}

console.log(
  "PASS - provider-mismatched manifest rejected"
);

const after =
  await sourceHash();

if (
  before !== after
) {
  throw new Error(
    "Capability processing modified application source"
  );
}

console.log(
  "PASS - capability declarations never enable auto-apply"
);

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
  "ONCE CAPABILITY REGRESSION PASSED"
);
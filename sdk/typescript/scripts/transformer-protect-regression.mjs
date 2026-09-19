import {
  createHash
} from "node:crypto";

import {
  mkdir,
  readFile,
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

const temp =
  path.join(
    root,
    ".transformer-protect-regression-temp"
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
      "Protect transformer regression failed"
    );
  }

  return result.stdout;
}

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

await mkdir(
  path.join(
    temp,
    ".once"
  ),
  {
    recursive: true
  }
);

const supportedPath =
  path.join(
    temp,
    "src",
    "supported.ts"
  );

const unsupportedPath =
  path.join(
    temp,
    "src",
    "unsupported.ts"
  );

const supportedSource = `
export async function sendSupported(
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

const unsupportedSource = `
export async function sendUnsupported(
  operationId: string,
  payload: unknown
) {
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
}
`.trimStart();

await writeFile(
  supportedPath,
  supportedSource,
  "utf8"
);

await writeFile(
  unsupportedPath,
  unsupportedSource,
  "utf8"
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
      provider: {
        name:
          "transformer-provider",
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
    temp,
    ".once",
    "provider-capabilities.json"
  ),
  JSON.stringify(
    {
      schema_version: 1,
      provider:
        "transformer-provider",
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

const beforeSupported =
  hash(
    await readFile(
      supportedPath
    )
  );

const beforeUnsupported =
  hash(
    await readFile(
      unsupportedPath
    )
  );

console.log("");
console.log(
  "ONCE TRANSFORMER -> PROTECT REGRESSION"
);
console.log(
  "======================================"
);

const output =
  runProtect();

if (
  !output.includes(
    "PATCHABLE"
  )
) {
  throw new Error(
    "Protect did not report transformer match"
  );
}

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
  plan.candidates.length !== 2
) {
  throw new Error(
    `Expected 2 candidates; got ${plan.candidates.length}`
  );
}

const supported =
  plan.candidates.find(
    candidate =>
      candidate.file
        .replaceAll(
          "\\",
          "/"
        )
        .endsWith(
          "src/supported.ts"
        )
  );

const unsupported =
  plan.candidates.find(
    candidate =>
      candidate.file
        .replaceAll(
          "\\",
          "/"
        )
        .endsWith(
          "src/unsupported.ts"
        )
  );

if (
  !supported
) {
  throw new Error(
    "Supported candidate missing"
  );
}

if (
  !unsupported
) {
  throw new Error(
    "Unsupported candidate missing"
  );
}

if (
  supported.category !==
  "HTTP_WRITE"
) {
  throw new Error(
    "Supported candidate category changed"
  );
}

if (
  supported.automation_status !==
  "PATCHABLE"
) {
  throw new Error(
    `Expected PATCHABLE; got ${JSON.stringify(supported.automation_status)}`
  );
}

if (
  supported.transformer_id !==
  "ts_fetch_post_void_v1"
) {
  throw new Error(
    "Wrong transformer selected"
  );
}

if (
  supported.patch_plan_id !==
  "ts_fetch_post_void_patch_v1"
) {
  throw new Error(
    "Complete patch plan identity missing"
  );
}

if (
  supported.binding_strategy !==
  "call-site-constructor"
) {
  throw new Error(
    "Expected call-site binding strategy"
  );
}

if (
  !supported.source_sha256 ||
  !supported.proposed_source_sha256 ||
  supported.source_sha256 ===
    supported.proposed_source_sha256
) {
  throw new Error(
    "Source/proposed-source fingerprints invalid"
  );
}


if (
  supported.binding_required !==
  false
) {
  throw new Error(
    "Once binding requirement was not preserved"
  );
}

if (
  supported.auto_apply_eligible !==
  true
) {
  throw new Error(
    "PATCHABLE candidate did not enable auto-apply eligibility"
  );
}

console.log(
  "PASS - exact source pattern reached PATCHABLE"
);

console.log(
  "PASS - transformer identity recorded"
);

console.log(
  "PASS - Once binding satisfied by patch planner"
);

console.log(
  "PASS - complete patch plan enables auto-apply eligibility"
);

//
// Authorized URL must be pinned into the Protect plan.
//

if (
  supported.target_url !==
  "https://api.example.invalid/orders"
) {
  throw new Error(
    `Expected pinned target URL; got ${JSON.stringify(supported.target_url)}`
  );
}

console.log(
  "PASS - authorized target URL pinned into Protect plan"
);

//
// Missing allowed_urls must fail closed.
//
// The capability declaration remains syntactically valid,
// but it must not authorize automatic source rewriting.
//

await writeFile(
  path.join(
    temp,
    ".once",
    "provider-capabilities.json"
  ),
  JSON.stringify(
    {
      schema_version: 1,
      provider:
        "transformer-provider",
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
  ) + "\n",
  "utf8"
);

runProtect();

const missingUrlPlan =
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

const missingUrlCandidate =
  missingUrlPlan.candidates.find(
    candidate =>
      candidate.file
        .replaceAll(
          "\\",
          "/"
        )
        .endsWith(
          "src/supported.ts"
        )
  );

if (!missingUrlCandidate) {
  throw new Error(
    "Missing-allowed_urls candidate missing"
  );
}

if (
  missingUrlCandidate.automation_status ===
  "PATCHABLE"
) {
  throw new Error(
    "Manifest without allowed_urls reached PATCHABLE"
  );
}

if (
  missingUrlCandidate.auto_apply_eligible !==
  false
) {
  throw new Error(
    "Manifest without allowed_urls enabled auto-apply"
  );
}

if (
  !String(
    missingUrlCandidate.transformer_reason ?? ""
  ).includes(
    "Capability does not explicitly allow target URL"
  )
) {
  throw new Error(
    "Missing-allowed_urls rejection reason missing"
  );
}

console.log(
  "PASS - missing allowed_urls fails closed"
);

//
// Wrong allowed URL must also fail closed.
//

await writeFile(
  path.join(
    temp,
    ".once",
    "provider-capabilities.json"
  ),
  JSON.stringify(
    {
      schema_version: 1,
      provider:
        "transformer-provider",
      capabilities: [
        {
          category:
            "HTTP_WRITE",
          action_type:
            "http_write_v1",
          allowed_urls: [
            "https://api.example.invalid/not-orders"
          ]
        }
      ]
    },
    null,
    2
  ) + "\n",
  "utf8"
);

runProtect();

const wrongUrlPlan =
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

const wrongUrlCandidate =
  wrongUrlPlan.candidates.find(
    candidate =>
      candidate.file
        .replaceAll(
          "\\",
          "/"
        )
        .endsWith(
          "src/supported.ts"
        )
  );

if (!wrongUrlCandidate) {
  throw new Error(
    "Wrong-allowed-url candidate missing"
  );
}

if (
  wrongUrlCandidate.automation_status ===
  "PATCHABLE"
) {
  throw new Error(
    "Wrong allowed URL reached PATCHABLE"
  );
}

if (
  wrongUrlCandidate.auto_apply_eligible !==
  false
) {
  throw new Error(
    "Wrong allowed URL enabled auto-apply"
  );
}

if (
  !String(
    wrongUrlCandidate.transformer_reason ?? ""
  ).includes(
    "Capability does not explicitly allow target URL"
  )
) {
  throw new Error(
    "Wrong-allowed-url rejection reason missing"
  );
}

console.log(
  "PASS - mismatched allowed URL fails closed"
);

//
// Restore valid capability declaration for fixture hygiene.
//

await writeFile(
  path.join(
    temp,
    ".once",
    "provider-capabilities.json"
  ),
  JSON.stringify(
    {
      schema_version: 1,
      provider:
        "transformer-provider",
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

if (
  unsupported.automation_status !==
  "PROVIDER_CAPABILITY_DECLARED"
) {
  throw new Error(
    "Unsupported request advanced beyond provider capability state"
  );
}

if (
  unsupported.auto_apply_eligible !==
  false
) {
  throw new Error(
    "Unsupported request enabled auto-apply"
  );
}

if (
  !String(
    unsupported.transformer_reason ?? ""
  ).includes(
    "exactly the fetch options"
  )
) {
  throw new Error(
    "Unsupported transformer rejection reason missing"
  );
}

console.log(
  "PASS - unsupported HTTP semantics fail closed"
);

console.log(
  "PASS - unsupported candidate remains capability-only"
);

const afterSupported =
  hash(
    await readFile(
      supportedPath
    )
  );

const afterUnsupported =
  hash(
    await readFile(
      unsupportedPath
    )
  );

if (
  beforeSupported !==
    afterSupported ||
  beforeUnsupported !==
    afterUnsupported
) {
  throw new Error(
    "Transformer classification modified application source"
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
  "ONCE TRANSFORMER -> PROTECT REGRESSION PASSED"
);
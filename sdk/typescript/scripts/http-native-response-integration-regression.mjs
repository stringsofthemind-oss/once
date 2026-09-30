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
    ".http-native-response-integration-temp"
  );

const provider =
  "native-response-regression-provider";

const targetUrl =
  "https://api.example.invalid/orders";

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

function capabilityManifest(
  {
    versionId = "provider-native-v2-1",
    includeV2 = true
  } = {}
) {
  return {
    schema_version: 1,
    provider,
    capabilities: [
      {
        category:
          "HTTP_WRITE",
        action_type:
          "http_write_v1",
        version_id:
          versionId,
        response_replay:
          "required",
        ...(includeV2
          ? {
              response_replay_v2:
                "required"
            }
          : {}),
        allowed_urls: [
          targetUrl
        ]
      }
    ]
  };
}

async function createProject(
  name,
  source,
  manifest = capabilityManifest()
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
        name: provider,
        type: "http_v1",
        version_id:
          "provider-native-v2-1"
      }
    }
  );

  await writeJson(
    path.join(
      directory,
      ".once",
      "provider-capabilities.json"
    ),
    manifest
  );

  return {
    directory,
    sourcePath,
    manifestPath:
      path.join(
        directory,
        ".once",
        "provider-capabilities.json"
      )
  };
}

function runProtect(
  directory,
  ...extra
) {
  return spawnSync(
    process.execPath,
    [
      cli,
      "protect",
      directory,
      ...extra
    ],
    {
      cwd: root,
      encoding: "utf8"
    }
  );
}

function assertSuccess(
  result,
  label
) {
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`${label} failed`);
  }
}

async function readPlan(
  directory
) {
  return JSON.parse(
    await readFile(
      path.join(
        directory,
        ".once",
        "protect-plan.json"
      ),
      "utf8"
    )
  );
}

const assignedSource = `
export async function createOrder(
  operationId: string,
  payload: unknown
) {
  const response = await fetch(
    "${targetUrl}",
    {
      method: "POST",
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    throw new Error(String(response.status));
  }

  const clone = response.clone();
  await clone.text();
  return response;
}
`.trimStart();

const returnedSource = `
export async function createOrder(
  operationId: string,
  payload: unknown
) {
  return await fetch(
    "${targetUrl}",
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

try {
  // Assigned Response: plan and apply through the public CLI.
  const assigned =
    await createProject(
      "assigned",
      assignedSource
    );

  const assignedApply =
    runProtect(
      assigned.directory,
      "--apply"
    );

  assertSuccess(
    assignedApply,
    "assigned native Response apply"
  );

  const assignedApplied =
    await readFile(
      assigned.sourcePath,
      "utf8"
    );

  if (
    !assignedApplied.includes(
      'import { executeHttpWriteResponse as __OnceAgentHttpResponse } from "@once-agent/sdk/http-response";'
    ) ||
    !assignedApplied.includes(
      "const response = await __OnceAgentHttpResponse({"
    ) ||
    assignedApplied.includes(
      "const response = await fetch("
    ) ||
    !assignedApplied.includes(
      "response.clone()"
    )
  ) {
    throw new Error(
      "assigned native Response source was not applied through the proven helper path"
    );
  }

  // Returned Response: plan and apply through the same public path.
  const returned =
    await createProject(
      "returned",
      returnedSource
    );

  const returnedApply =
    runProtect(
      returned.directory,
      "--apply"
    );

  assertSuccess(
    returnedApply,
    "returned native Response apply"
  );

  const returnedApplied =
    await readFile(
      returned.sourcePath,
      "utf8"
    );

  if (
    !returnedApplied.includes(
      "return await __OnceAgentHttpResponse({"
    ) ||
    returnedApplied.includes(
      "return await fetch("
    )
  ) {
    throw new Error(
      "returned native Response source was not applied through the proven helper path"
    );
  }

  // Legacy v1-only replay evidence must never qualify native Response source.
  const v1Only =
    await createProject(
      "v1-only",
      assignedSource,
      capabilityManifest({
        includeV2: false
      })
    );

  const v1PlanResult =
    runProtect(
      v1Only.directory,
      "--write-plan"
    );

  assertSuccess(
    v1PlanResult,
    "v1-only protect planning"
  );

  const v1Plan =
    await readPlan(
      v1Only.directory
    );

  if (
    v1Plan.candidates.length !== 1 ||
    v1Plan.candidates[0].automation_status ===
      "PATCHABLE" ||
    v1Plan.candidates[0].auto_apply_eligible !==
      false ||
    !String(
      v1Plan.candidates[0].automation_reason
    ).toLowerCase().includes(
      "replay v2"
    )
  ) {
    throw new Error(
      "legacy v1-only capability incorrectly qualified native Response source"
    );
  }

  const v1Unchanged =
    await readFile(
      v1Only.sourcePath,
      "utf8"
    );

  if (v1Unchanged !== assignedSource) {
    throw new Error(
      "v1-only planning modified application source"
    );
  }

  // Provider version/capability evidence is pinned between planning and apply.
  const drift =
    await createProject(
      "capability-drift",
      assignedSource
    );

  const driftPlanResult =
    runProtect(
      drift.directory,
      "--write-plan"
    );

  assertSuccess(
    driftPlanResult,
    "capability-drift protect planning"
  );

  const driftPlan =
    await readPlan(
      drift.directory
    );

  if (
    driftPlan.candidates.length !== 1 ||
    driftPlan.candidates[0].automation_status !==
      "PATCHABLE" ||
    !/^[a-f0-9]{64}$/.test(
      driftPlan.candidates[0].capability_fingerprint ?? ""
    )
  ) {
    throw new Error(
      "native Response plan did not pin replay-v2 capability evidence"
    );
  }

  await writeJson(
    drift.manifestPath,
    capabilityManifest({
      versionId:
        "provider-native-v2-2"
    })
  );

  let driftBlocked = false;

  try {
    await applyProtectionPlan(
      drift.directory
    );
  }
  catch (error) {
    driftBlocked =
      String(error).includes(
        "capability evidence changed"
      );
  }

  if (!driftBlocked) {
    throw new Error(
      "provider replay-v2 capability drift was not blocked"
    );
  }

  const driftUnchanged =
    await readFile(
      drift.sourcePath,
      "utf8"
    );

  if (driftUnchanged !== assignedSource) {
    throw new Error(
      "capability-drift refusal modified application source"
    );
  }

  console.log(
    "PASS - assigned native Response reaches PATCHABLE and applies through @once-agent/sdk/http-response"
  );
  console.log(
    "PASS - returned native Response reaches PATCHABLE and applies through the same helper"
  );
  console.log(
    "PASS - v1-only replay capability stays fail-closed for native Response source"
  );
  console.log(
    "PASS - replay-v2 provider capability fingerprint is revalidated at apply time"
  );
}
finally {
  await rm(
    tempRoot,
    {
      recursive: true,
      force: true
    }
  );
}

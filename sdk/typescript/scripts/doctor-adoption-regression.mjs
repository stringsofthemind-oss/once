import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root =
  await mkdtemp(
    path.join(
      os.tmpdir(),
      "once-doctor-adoption-"
    )
  );

try {
  const src = path.join(root, "src");
  await mkdir(src, { recursive: true });

  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "doctor-fixture",
        private: true,
        dependencies: {
          openai: "^6.0.0"
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const sourcePath =
    path.join(src, "refund.ts");

  const source = [
    "export async function issueRefund(stripe, paymentIntentId) {",
    "  return stripe.refunds.create({ payment_intent: paymentIntentId });",
    "}",
    ""
  ].join("\n");

  await writeFile(
    sourcePath,
    source,
    "utf8"
  );

  const env = { ...process.env };
  delete env.ONCE_API_KEY;

  const result =
    spawnSync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "doctor",
        root
      ],
      {
        encoding: "utf8",
        env
      }
    );

  assert.equal(
    result.status,
    0,
    `doctor should succeed without an API key\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );

  assert.match(
    result.stdout,
    /Once Doctor/
  );
  assert.match(
    result.stdout,
    /API key required: no/
  );
  assert.match(
    result.stdout,
    /Consequential-operation candidates: 1/
  );
  assert.match(
    result.stdout,
    /issueRefund\(\)/
  );
  assert.match(
    result.stdout,
    /HIGH · PAYMENT/
  );
  assert.match(
    result.stdout,
    /PROTECTION READINESS/
  );
  assert.match(
    result.stdout,
    /Tool\/capability records:/
  );
  assert.match(
    result.stdout,
    /Configured tool sources:/
  );
  assert.match(
    result.stdout,
    /PROTECT_PRIORITY/
  );
  assert.match(
    result.stdout,
    /CRITICAL_GAP/
  );
  assert.match(
    result.stdout,
    /Discovery remained local\/read-only: no tool was invoked, no configured stdio server was launched, and no provider was contacted\./
  );
  assert.match(
    result.stdout,
    /npx --yes --package=@once-agent\/sdk once doctor .* --protect/
  );
  assert.match(
    result.stdout,
    /npx --yes --package=@once-agent\/sdk once doctor .* --protect --apply/
  );
  assert.match(
    result.stdout,
    /No source files were changed\./
  );

  assert.equal(
    await readFile(sourcePath, "utf8"),
    source,
    "doctor must not modify source files"
  );

  await assert.rejects(
    access(
      path.join(root, ".once")
    ),
    "default doctor must not create Once project state"
  );

  const protectReview =
    spawnSync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "doctor",
        root,
        "--protect"
      ],
      {
        encoding: "utf8",
        env
      }
    );

  assert.equal(
    protectReview.status,
    0,
    `doctor --protect should generate review artifacts without changing source\nstdout:\n${protectReview.stdout}\nstderr:\n${protectReview.stderr}`
  );
  assert.match(
    protectReview.stdout,
    /AUTOMATIC WIRING PLAN/
  );
  assert.match(
    protectReview.stdout,
    /Plan only: no tool was invoked, no provider was contacted, and no application source was modified\./
  );

  const autoprotectPlan =
    JSON.parse(
      await readFile(
        path.join(
          root,
          ".once",
          "autoprotect-plan.json"
        ),
        "utf8"
      )
    );

  assert.equal(
    autoprotectPlan.schema_version,
    1
  );
  assert.equal(
    autoprotectPlan.mode,
    "PLAN_ONLY"
  );
  assert.equal(
    autoprotectPlan.source_modified,
    false
  );
  assert.equal(
    autoprotectPlan.provider_contacted,
    false
  );
  assert.equal(
    autoprotectPlan.tool_invocation_performed,
    false
  );
  assert.equal(
    autoprotectPlan.execution_authority,
    "EXISTING_CONNECT_GATEWAY_PROTECTLOCAL_RUNTIME"
  );
  assert.ok(
    autoprotectPlan.summary.total >= 1,
    "automatic wiring plan should include the discovered refund capability"
  );
  assert.ok(
    autoprotectPlan.summary.protect_required >= 1,
    "refund capability should remain on a protection-required path"
  );

  assert.equal(
    await readFile(sourcePath, "utf8"),
    source,
    "doctor --protect may write review artifacts but must not modify application source"
  );

  const connection =
    spawnSync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "doctor",
        root,
        "--connection"
      ],
      {
        encoding: "utf8",
        env
      }
    );

  assert.equal(
    connection.status,
    1,
    "explicit hosted connection verification should fail closed without ONCE_API_KEY"
  );
  assert.match(
    connection.stdout,
    /Hosted connection verification needs ONCE_API_KEY/
  );

  const emptyProject = path.join(root, "empty");
  await mkdir(emptyProject);
  const emptyResult = spawnSync(
    process.execPath,
    [path.resolve("dist/cli.js"), "doctor", emptyProject],
    { encoding: "utf8", env }
  );
  assert.equal(emptyResult.status, 0);
  assert.match(
    emptyResult.stdout,
    /PROTECTION READINESS/
  );
  assert.match(
    emptyResult.stdout,
    /npx --yes --package=@once-agent\/sdk once scan .* --no-estimate/
  );

  console.log("doctor adoption regression: PASS");
} finally {
  await rm(
    root,
    {
      recursive: true,
      force: true
    }
  );
}

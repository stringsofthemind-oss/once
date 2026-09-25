import assert from "node:assert/strict";
import {
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
    /once protect .* --all --snippets/
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

import {
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";

import {
  existsSync
} from "node:fs";

import {
  spawnSync
} from "node:child_process";

import os from "node:os";
import path from "node:path";

const root =
  process.cwd();

const unique =
  `${process.pid}-${Date.now()}`;

const packDirectory =
  path.join(
    os.tmpdir(),
    `once-consumer-pack-${unique}`
  );

const sandbox =
  path.join(
    os.tmpdir(),
    `once-consumer-contract-${unique}`
  );

function run(
  command,
  args,
  options = {}
) {

  const isWindowsNpm =
    process.platform === "win32" &&
    command.toLowerCase() === "npm.cmd";

  const executable =
    isWindowsNpm
      ? (
          process.env.ComSpec ||
          "cmd.exe"
        )
      : command;

  const executableArgs =
    isWindowsNpm
      ? [
          "/d",
          "/c",
          "npm.cmd",
          ...args
        ]
      : args;

  const result =
    spawnSync(
      executable,
      executableArgs,
      {
        encoding:
          "utf8",

        ...options
      }
    );

  if (
    result.error
  ) {
    throw result.error;
  }

  return result;
}

const npm =
  process.platform === "win32"
    ? "npm.cmd"
    : "npm";

console.log("");
console.log(
  "ONCE CONSUMER PACKAGE REGRESSION"
);

console.log(
  "================================"
);

await rm(
  packDirectory,
  {
    recursive: true,
    force: true
  }
);

await rm(
  sandbox,
  {
    recursive: true,
    force: true
  }
);

await mkdir(
  packDirectory,
  {
    recursive: true
  }
);

await mkdir(
  sandbox,
  {
    recursive: true
  }
);

try {

  // ================================================
  // PACK REAL ARTIFACT
  // ================================================

  const packed =
    run(
      npm,
      [
        "pack",
        "--json",
        "--pack-destination",
        packDirectory
      ],
      {
        cwd: root
      }
    );

  if (
    packed.status !== 0
  ) {

    console.error(
      packed.stdout
    );

    console.error(
      packed.stderr
    );

    throw new Error(
      "npm pack failed"
    );
  }

  const packInfo =
    JSON.parse(
      packed.stdout
    );

  const tarball =
    path.join(
      packDirectory,
      packInfo[0].filename
    );

  if (
    !existsSync(
      tarball
    )
  ) {
    throw new Error(
      "Tarball missing"
    );
  }

  console.log(
    "PASS - fresh SDK tarball created"
  );

  // ================================================
  // CLEAN CUSTOMER PROJECT
  // ================================================

  await writeFile(
    path.join(
      sandbox,
      "package.json"
    ),
    JSON.stringify(
      {
        name:
          "once-consumer-regression",

        version:
          "1.0.0",

        private:
          true,

        type:
          "module",

        scripts: {
          typecheck:
            "tsc --noEmit"
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await writeFile(
    path.join(
      sandbox,
      "tsconfig.json"
    ),
    JSON.stringify(
      {
        compilerOptions: {
          target:
            "ES2022",

          module:
            "NodeNext",

          moduleResolution:
            "NodeNext",

          strict:
            true,

          noEmit:
            true,

          skipLibCheck:
            false
        },

        include: [
          "consumer.ts"
        ]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const consumer = `
import {
  Once,
  OnceError
} from "@once-agent/sdk";

const once =
  new Once({
    apiKey:
      "test-only-not-real",

    baseUrl:
      "https://example.invalid"
  });

async function verify(): Promise<void> {

  const execution =
    await once.execute({
      operationId:
        "order-123",

      provider:
        "customer-api",

      action: {
        type:
          "http_write_v1",

        method:
          "POST"
      }
    });

  const state:
    string =
      execution.state;

  const truth =
    await once.truth(
      "order-123"
    );

  const ledgerState:
    string =
      truth.ledger_state;

  console.log(
    state,
    ledgerState
  );
}

void verify;

const errorClass:
  typeof OnceError =
    OnceError;

void errorClass;
`.trimStart();

  await writeFile(
    path.join(
      sandbox,
      "consumer.ts"
    ),
    consumer,
    "utf8"
  );

  console.log(
    "PASS - isolated consumer project created"
  );

  // ================================================
  // INSTALL REAL TARBALL
  // ================================================

  const installed =
    run(
      npm,
      [
        "install",
        tarball
      ],
      {
        cwd: sandbox
      }
    );

  if (
    installed.status !== 0
  ) {

    console.error(
      installed.stdout
    );

    console.error(
      installed.stderr
    );

    throw new Error(
      "Consumer npm install failed"
    );
  }

  console.log(
    "PASS - actual tarball installed"
  );

  // ================================================
  // PACKAGE METADATA
  // ================================================

  const installedPackagePath =
    path.join(
      sandbox,
      "node_modules",
      "@once-agent",
      "sdk",
      "package.json"
    );

  if (
    !existsSync(
      installedPackagePath
    )
  ) {
    throw new Error(
      "Installed package.json missing"
    );
  }

  const installedPackage =
    JSON.parse(
      await readFile(
        installedPackagePath,
        "utf8"
      )
    );

  if (
    installedPackage.name !==
    "@once-agent/sdk"
  ) {
    throw new Error(
      "Installed package name incorrect"
    );
  }

  if (
    !installedPackage.types
  ) {
    throw new Error(
      "Package types entry missing"
    );
  }

  if (
    !installedPackage.bin?.once
  ) {
    throw new Error(
      "Package once CLI bin entry missing"
    );
  }

  const packageRoot =
    path.dirname(
      installedPackagePath
    );

  if (
    !existsSync(
      path.join(
        packageRoot,
        installedPackage.types
      )
    )
  ) {
    throw new Error(
      "Declared type file is missing"
    );
  }

  console.log(
    "PASS - installed package metadata valid"
  );

  console.log(
    "PASS - declaration entry resolves"
  );

  console.log(
    "PASS - once CLI bin entry resolves"
  );

  // ================================================
  // CUSTOMER TYPECHECK
  // ================================================

  const typecheck =
    run(
      npm,
      [
        "run",
        "typecheck"
      ],
      {
        cwd: sandbox
      }
    );

  if (
    typecheck.status !== 0
  ) {

    console.error(
      typecheck.stdout
    );

    console.error(
      typecheck.stderr
    );

    throw new Error(
      "Consumer TypeScript contract failed"
    );
  }

  console.log(
    "PASS - package root import typechecks"
  );

  console.log(
    "PASS - Once constructor typechecks"
  );

  console.log(
    "PASS - operationId contract typechecks"
  );

  console.log(
    "PASS - execute().state contract typechecks"
  );

  console.log(
    "PASS - truth().ledger_state contract typechecks"
  );

  console.log(
    "PASS - OnceError export typechecks"
  );

  // ================================================
  // RUNTIME IMPORT
  // ================================================

  const runtime =
    run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import("@once-agent/sdk")
  .then((m) => {
    if (
      typeof m.Once !== "function" ||
      typeof m.OnceError !== "function"
    ) {
      process.exit(2);
    }

    console.log("RUNTIME IMPORT PASS");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
`
      ],
      {
        cwd: sandbox
      }
    );

  if (
    runtime.status !== 0
  ) {

    console.error(
      runtime.stdout
    );

    console.error(
      runtime.stderr
    );

    throw new Error(
      "Consumer runtime import failed"
    );
  }

  if (
    !runtime.stdout.includes(
      "RUNTIME IMPORT PASS"
    )
  ) {
    throw new Error(
      "Runtime import confirmation missing"
    );
  }

  console.log(
    "PASS - package runtime import works"
  );

  console.log("");
  console.log(
    "ONCE CONSUMER PACKAGE REGRESSION PASSED"
  );

} finally {

  await rm(
    sandbox,
    {
      recursive: true,
      force: true
    }
  );

  await rm(
    packDirectory,
    {
      recursive: true,
      force: true
    }
  );
}
import {
  mkdir,
  readFile,
  readdir,
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

const npm =
  process.platform === "win32"
    ? "npm.cmd"
    : "npm";

const unique =
  `${process.pid}-${Date.now()}`;

const packDirectory =
  path.join(
    os.tmpdir(),
    `once-package-regression-pack-${unique}`
  );

const sandbox =
  path.join(
    os.tmpdir(),
    `once-package-regression-customer-${unique}`
  );

function run(
  command,
  args,
  options = {}
) {

  /*
   * On Windows, spawning npm.cmd directly can fail
   * with EINVAL under Node. Route npm through the
   * Windows command processor instead.
   */
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
        encoding: "utf8",
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

console.log("");
console.log(
  "ONCE PACKAGED ARTIFACT REGRESSION"
);

console.log(
  "================================="
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
  path.join(
    sandbox,
    "src"
  ),
  {
    recursive: true
  }
);

await mkdir(
  path.join(
    sandbox,
    ".once"
  ),
  {
    recursive: true
  }
);

try {

  // ================================================
  // PACK THE ACTUAL PUBLISHABLE ARTIFACT
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

  if (
    !Array.isArray(
      packInfo
    ) ||
    packInfo.length !== 1 ||
    !packInfo[0].filename
  ) {
    throw new Error(
      "Unexpected npm pack output"
    );
  }

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
      "Packed tarball not found"
    );
  }

  console.log(
    "PASS - fresh publishable tarball created"
  );

  // ================================================
  // CREATE COMPLETELY ISOLATED CUSTOMER PROJECT
  // ================================================

  await writeJson(
    path.join(
      sandbox,
      "package.json"
    ),
    {
      name:
        "once-package-regression-customer",

      version:
        "1.0.0",

      private:
        true,

      type:
        "module"
    }
  );

  const source = `
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

  const sourcePath =
    path.join(
      sandbox,
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
      sandbox,
      ".once",
      "config.json"
    ),
    {
      version:
        1,

      provider: {
        name:
          "packaged-regression-provider",

        type:
          "http_v1",

        version_id:
          "pv_00000000000000000000000000000000"
      }
    }
  );

  await writeJson(
    path.join(
      sandbox,
      ".once",
      "provider-capabilities.json"
    ),
    {
      schema_version:
        1,

      provider:
        "packaged-regression-provider",

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
    }
  );

  console.log(
    "PASS - isolated customer fixture created outside repository"
  );

  // ================================================
  // INSTALL TARBALL
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
      "Isolated npm install failed"
    );
  }

  console.log(
    "PASS - tarball installed in isolated project"
  );

  // ================================================
  // RUNTIME DEPENDENCY PROOF
  // ================================================

  const typescriptPackage =
    path.join(
      sandbox,
      "node_modules",
      "typescript",
      "package.json"
    );

  if (
    !existsSync(
      typescriptPackage
    )
  ) {
    throw new Error(
      "TypeScript runtime dependency missing from isolated install"
    );
  }

  const typescript =
    JSON.parse(
      await readFile(
        typescriptPackage,
        "utf8"
      )
    );

  if (
    !typescript.version
  ) {
    throw new Error(
      "Installed TypeScript package has no version"
    );
  }

  console.log(
    `PASS - runtime TypeScript installed (${typescript.version})`
  );

  // ================================================
  // INSTALLED PACKAGE CONTENT
  // ================================================

  const packageRoot =
    path.join(
      sandbox,
      "node_modules",
      "@once-agent",
      "sdk"
    );

  const cli =
    path.join(
      packageRoot,
      "dist",
      "cli.js"
    );

  const requiredFiles = [
    "dist/index.js",
    "dist/protect.js",
    "dist/apply.js",
    "dist/transformers/http-write-v1.js",
    "dist/transformers/once-binding-v1.js",
    "dist/transformers/http-patch-plan-v1.js"
  ];

  if (
    !existsSync(
      cli
    )
  ) {
    throw new Error(
      "Installed CLI missing"
    );
  }

  for (
    const relative
    of requiredFiles
  ) {

    if (
      !existsSync(
        path.join(
          packageRoot,
          relative
        )
      )
    ) {
      throw new Error(
        `Installed package missing ${relative}`
      );
    }
  }

  console.log(
    "PASS - required runtime package files present"
  );

  // ================================================
  // EXECUTE THE INSTALLED CLI ONLY
  // ================================================

  const applied =
    run(
      process.execPath,
      [
        cli,
        "protect",
        ".",
        "--apply"
      ],
      {
        cwd: sandbox
      }
    );

  if (
    applied.status !== 0
  ) {

    console.error(
      applied.stdout
    );

    console.error(
      applied.stderr
    );

    throw new Error(
      "Packaged protect --apply failed"
    );
  }

  if (
    !applied.stdout.includes(
      "ONCE PROTECTION APPLIED"
    )
  ) {
    throw new Error(
      "Packaged CLI success confirmation missing"
    );
  }

  console.log(
    "PASS - installed CLI protect --apply succeeded"
  );

  // ================================================
  // VERIFY TRANSFORMED CUSTOMER SOURCE
  // ================================================

  const transformed =
    await readFile(
      sourcePath,
      "utf8"
    );

  if (
    !transformed.includes(
      'import { Once as __OnceAgentClient } from "@once-agent/sdk";'
    )
  ) {
    throw new Error(
      "Once SDK import missing"
    );
  }

  if (
    !transformed.includes(
      "await new __OnceAgentClient().execute("
    )
  ) {
    throw new Error(
      "Once execution missing"
    );
  }

  if (
    transformed.includes(
      "await fetch("
    )
  ) {
    throw new Error(
      "Original fetch remains"
    );
  }

  if (
    !transformed.includes(
      'provider: "packaged-regression-provider"'
    )
  ) {
    throw new Error(
      "Configured provider not preserved"
    );
  }

  if (
    !transformed.includes(
      "operationId"
    )
  ) {
    throw new Error(
      "Stable operationId not preserved"
    );
  }

  console.log(
    "PASS - packaged transformation is correct"
  );

  // ================================================
  // VERIFY EXACT BACKUP
  // ================================================

  const backupRoot =
    path.join(
      sandbox,
      ".once",
      "backups"
    );

  const callsiteDirectories =
    await readdir(
      backupRoot
    );

  if (
    callsiteDirectories.length !== 1
  ) {
    throw new Error(
      "Expected one backup callsite directory"
    );
  }

  const backupDirectory =
    path.join(
      backupRoot,
      callsiteDirectories[0]
    );

  const backupFiles =
    await readdir(
      backupDirectory
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
        backupDirectory,
        backupFiles[0]
      ),
      "utf8"
    );

  if (
    backup !==
    source
  ) {
    throw new Error(
      "Backup differs from exact original source"
    );
  }

  console.log(
    "PASS - exact customer source backup preserved"
  );

  // ================================================
  // VERIFY TEMP FILE CLEANUP
  // ================================================

  const temporaryFiles =
    [];

  async function walk(
    directory
  ) {

    const entries =
      await readdir(
        directory,
        {
          withFileTypes:
            true
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

      } else if (
        entry.name.startsWith(
          ".once-"
        ) &&
        entry.name.endsWith(
          ".tmp"
        )
      ) {

        temporaryFiles.push(
          full
        );
      }
    }
  }

  await walk(
    sandbox
  );

  if (
    temporaryFiles.length !== 0
  ) {
    throw new Error(
      "Temporary apply files remain after packaged execution"
    );
  }

  console.log(
    "PASS - packaged execution left no temporary patch files"
  );

  console.log("");
  console.log(
    "ONCE PACKAGED ARTIFACT REGRESSION PASSED"
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
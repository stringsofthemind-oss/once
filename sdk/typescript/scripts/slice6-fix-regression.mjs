import {
  readFile,
  writeFile
} from "node:fs/promises";

const file =
  new URL(
    "./http-native-response-integration-regression.mjs",
    import.meta.url
  );

let source =
  await readFile(
    file,
    "utf8"
  );

const anchors = [
  [
    `  const v1PlanResult =\n    runProtect(\n      v1Only.directory,\n      "--write-plan"\n    );`,
    `  const v1PlanResult =\n    runProtect(\n      v1Only.directory,\n      "--all",\n      "--write-plan"\n    );`
  ],
  [
    `  const driftPlanResult =\n    runProtect(\n      drift.directory,\n      "--write-plan"\n    );`,
    `  const driftPlanResult =\n    runProtect(\n      drift.directory,\n      "--all",\n      "--write-plan"\n    );`
  ]
];

for (const [before, after] of anchors) {
  const count =
    source.split(before).length - 1;

  if (count !== 1) {
    throw new Error(
      `expected exactly one regression anchor, found ${count}`
    );
  }

  source =
    source.replace(
      before,
      after
    );
}

await writeFile(
  file,
  source,
  "utf8"
);

console.log(
  "slice6 regression fixture fix authored"
);

import {
  readFile,
  writeFile
} from "node:fs/promises";

const file =
  new URL(
    "../src/apply.ts",
    import.meta.url
  );

let source =
  await readFile(
    file,
    "utf8"
  );

const replacements = [
  [
    "    proposedSource =\n      proposedSource;",
    "    proposedSource =\n      patch.proposedSource;"
  ],
  [
    "    recomputedSourceSha256 =\n      recomputedSourceSha256;",
    "    recomputedSourceSha256 =\n      patch.sourceSha256;"
  ],
  [
    "    recomputedProposedSourceSha256 =\n      proposedSourceSha256;",
    "    recomputedProposedSourceSha256 =\n      patch.proposedSourceSha256;"
  ],
  [
    "      proposedSourceSha256\n",
    "      recomputedProposedSourceSha256\n"
  ],
  [
    "        proposedSourceSha256\n",
    "        recomputedProposedSourceSha256\n"
  ]
];

for (const [before, after] of replacements) {
  const count =
    source.split(before).length - 1;

  if (count !== 1) {
    throw new Error(
      `expected exactly one apply fix anchor, found ${count}: ${before}`
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
  "slice6 apply typing fix authored"
);

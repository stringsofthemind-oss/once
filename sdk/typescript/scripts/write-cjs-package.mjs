import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const out = path.join(root, "dist-cjs");

await fs.mkdir(out, {
  recursive: true
});

await fs.writeFile(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      type: "commonjs"
    },
    null,
    2
  ) + "\n",
  "utf8"
);

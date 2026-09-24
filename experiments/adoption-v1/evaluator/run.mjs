import path from "node:path";
import { evaluate } from "./hidden-evaluator.mjs";

const fixturePath =
  path.resolve(process.argv[2] ?? "");

if (!process.argv[2]) {
  console.error(
    "Usage: node run.mjs <candidate-fixture-path>"
  );
  process.exit(2);
}

const result = await evaluate(fixturePath);

console.log(
  JSON.stringify(result, null, 2)
);

process.exit(result.pass ? 0 : 1);

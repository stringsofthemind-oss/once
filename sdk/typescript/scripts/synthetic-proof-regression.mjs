import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const result = spawnSync(
  process.execPath,
  [
    path.resolve("dist/cli.js"),
    "prove"
  ],
  {
    encoding: "utf8"
  }
);

assert.equal(
  result.status,
  0,
  `once prove should pass on the Node 24.15+ local-safety lane\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
);

assert.match(
  result.stdout,
  /Once Synthetic Retry Proof/
);
assert.match(
  result.stdout,
  /Real provider\/tool execution: none/
);
assert.match(
  result.stdout,
  /Effect committed, acknowledgement lost -> UNKNOWN/
);
assert.match(
  result.stdout,
  /Immediate retry -> UNKNOWN \(blocked, no redispatch\)/
);
assert.match(
  result.stdout,
  /Authoritative synthetic reconciliation -> CONFIRMED/
);
assert.match(
  result.stdout,
  /Confirmed replay -> CONFIRMED/
);
assert.match(
  result.stdout,
  /External synthetic effects: 1/
);
assert.match(
  result.stdout,
  /SYNTHETIC RETRY PROOF: PASS/
);
assert.match(
  result.stdout,
  /does not claim that this project's real tools are wired or provider-reconcilable/
);
assert.doesNotMatch(
  result.stdout,
  /ONCE PROTECTED/
);

const rejected = spawnSync(
  process.execPath,
  [
    path.resolve("dist/cli.js"),
    "prove",
    "."
  ],
  {
    encoding: "utf8"
  }
);

assert.equal(
  rejected.status,
  1,
  "once prove must reject project/provider arguments rather than accidentally touching them"
);
assert.match(
  rejected.stderr,
  /isolated synthetic local proof/
);

console.log("synthetic proof regression: PASS");

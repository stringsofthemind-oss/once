import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyLocalFunctionBridgePlan,
  writeLocalFunctionBridgePlan,
} from "../dist/local-function-bridge.js";

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 24 || (major === 24 && minor < 15)) {
  throw new Error("local-function bridge apply regression requires Node.js 24.15+");
}

const root = process.cwd();
const temp = path.join(root, ".local-function-bridge-apply-regression-temp");
const previousCwd = process.cwd();

await rm(temp, { recursive: true, force: true });
await mkdir(temp, { recursive: true });

try {
  const source = [
    "export const effects = [];",
    "",
    "export const provider = {",
    "  async createOrder({ orderId, amountCents }) {",
    "    const receipt = { orderId, amountCents, status: \"created\" };",
    "    effects.push(receipt);",
    "    if (orderId === \"lost-response\") {",
    "      throw new Error(\"response lost after commit\");",
    "    }",
    "    return receipt;",
    "  }",
    "};",
    "",
    "export const createOrder = async ({ orderId, amountCents }) =>",
    "  provider.createOrder({ orderId, amountCents });",
    "",
  ].join("\n");

  const sourcePath = path.join(temp, "orders.mjs");
  await writeFile(sourcePath, source, "utf8");

  const plan = await writeLocalFunctionBridgePlan(temp, {
    target: "orders.mjs:createOrder",
    idPrefix: "create-order",
    idField: "orderId",
  });

  assert.equal(plan.source_modified, false);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  const applied = await applyLocalFunctionBridgePlan(temp);
  assert.equal(applied.file, "orders.mjs");
  assert.equal(applied.functionName, "createOrder");
  assert.equal(applied.sourceSha256, plan.target.source_sha256);
  assert.equal(applied.appliedSha256, plan.target.proposed_source_sha256);
  await access(applied.backupPath);
  assert.equal(await readFile(applied.backupPath, "utf8"), source);

  const transformed = await readFile(sourcePath, "utf8");
  assert.match(
    transformed,
    /import \{ Once as __OnceAgentId, protectLocal as __OnceProtectLocal \} from "@once-agent\/sdk";/,
  );
  assert.match(transformed, /__OnceProtectLocal\(/);
  assert.match(transformed, /__OnceAgentId\.id\("create-order", orderId\)/);
  assert.match(
    transformed,
    /payload: \(\{ orderId, amountCents \}\) => \(\{ orderId, amountCents \}\)/,
  );
  assert.equal(
    (transformed.match(/provider\.createOrder\(\{ orderId, amountCents \}\)/g) ?? []).length,
    1,
    "the original effect call must appear exactly once after protection",
  );

  process.chdir(temp);
  const moduleUrl = pathToFileURL(sourcePath).href + `?bridge=${Date.now()}`;
  const app = await import(moduleUrl);

  const first = await app.createOrder({ orderId: "order-1", amountCents: 500 });
  const replay = await app.createOrder({ orderId: "order-1", amountCents: 500 });

  assert.deepEqual(replay, first, "confirmed retry must replay the stored receipt");
  assert.equal(app.effects.length, 1, "confirmed retry must not dispatch a second order");

  await assert.rejects(
    app.createOrder({ orderId: "order-1", amountCents: 700 }),
    error => error?.code === "CONFLICT",
    "same logical id with changed effect payload must fail closed",
  );
  assert.equal(app.effects.length, 1, "payload conflict must not dispatch");

  await assert.rejects(
    app.createOrder({ orderId: "lost-response", amountCents: 900 }),
    error => error?.code === "UNKNOWN",
    "lost acknowledgement simulation must become UNKNOWN",
  );
  assert.equal(app.effects.length, 2, "first ambiguous attempt may have committed one effect");

  await assert.rejects(
    app.createOrder({ orderId: "lost-response", amountCents: 900 }),
    error => error?.code === "UNKNOWN",
    "retry after ambiguous outcome must remain blocked without reconciliation",
  );
  assert.equal(app.effects.length, 2, "UNKNOWN retry must not redispatch");

  const second = await app.createOrder({ orderId: "order-2", amountCents: 300 });
  assert.equal(second.orderId, "order-2");
  assert.equal(app.effects.length, 3, "new explicit logical id may dispatch a new order");

  await access(path.join(temp, ".once", "operations.sqlite"));

  console.log("local-function bridge transactional apply regression: PASS");
} finally {
  process.chdir(previousCwd);
  await rm(temp, { recursive: true, force: true });
}

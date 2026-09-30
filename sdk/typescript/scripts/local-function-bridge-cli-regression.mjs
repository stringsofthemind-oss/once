import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "dist", "once-cli.js");
const temp = path.join(root, ".local-function-bridge-cli-temp");
const sourcePath = path.join(temp, "orders.mjs");
const localPlanPath = path.join(temp, ".once", "local-function-protect-plan.json");

const source = [
  "export const provider = {",
  "  async createOrder({ orderId, amountCents }) {",
  "    return { orderId, amountCents, status: \"created\" };",
  "  }",
  "};",
  "",
  "export const createOrder = async ({ orderId, amountCents }) =>",
  "  provider.createOrder({ orderId, amountCents });",
  "",
].join("\n");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ONCE_API_KEY: "",
    },
  });
}

function combined(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

await rm(temp, { recursive: true, force: true });
await mkdir(temp, { recursive: true });
await writeFile(sourcePath, source, "utf8");

try {
  const help = run(["--help"]);
  assert.equal(help.status, 0, combined(help));
  assert.match(help.stdout, /once protect-local \[directory\]/);
  assert.match(help.stdout, /Identity is never inferred/);

  const doctor = run(["doctor", temp, "--protect"]);
  assert.equal(doctor.status, 0, combined(doctor));
  assert.match(doctor.stdout, /Automation: ADAPTER_REQUIRED/);
  assert.match(doctor.stdout, /LOCAL BOOKING\/ORDER BRIDGE/);
  assert.match(doctor.stdout, /once protect-local/);
  assert.match(doctor.stdout, /does not make the candidate automatically patchable/);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  const incomplete = run([
    "protect-local",
    temp,
    "--target=orders.mjs:createOrder",
    "--id-prefix=create-order",
  ]);
  assert.notEqual(incomplete.status, 0);
  assert.match(combined(incomplete), /Identity is never inferred/);
  assert.equal(await exists(localPlanPath), false);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  const planResult = run([
    "protect-local",
    temp,
    "--target=orders.mjs:createOrder",
    "--id-prefix=create-order",
    "--id-field=orderId",
  ]);
  assert.equal(planResult.status, 0, combined(planResult));
  assert.match(planResult.stdout, /Once Local Protection Plan/);
  assert.match(planResult.stdout, /Source modified: no/);
  assert.match(planResult.stdout, /Identity field: orderId/);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  const plan = JSON.parse(await readFile(localPlanPath, "utf8"));
  assert.equal(plan.kind, "local_function_v1");
  assert.equal(plan.source_modified, false);
  assert.equal(plan.target.file, "orders.mjs");
  assert.equal(plan.target.function_name, "createOrder");
  assert.equal(plan.target.id_prefix, "create-order");
  assert.equal(plan.target.id_field, "orderId");
  assert.deepEqual(plan.target.input_fields, ["orderId", "amountCents"]);

  const unsafeOneShot = run([
    "protect-local",
    temp,
    "--apply",
    "--target=orders.mjs:createOrder",
    "--id-prefix=create-order",
    "--id-field=orderId",
  ]);
  assert.notEqual(unsafeOneShot.status, 0);
  assert.match(combined(unsafeOneShot), /already-reviewed/);
  assert.equal(await readFile(sourcePath, "utf8"), source);

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const localRuntimeReady = major > 24 || (major === 24 && minor >= 15);
  const applyResult = run(["protect-local", temp, "--apply"]);

  if (!localRuntimeReady) {
    assert.notEqual(applyResult.status, 0);
    assert.match(combined(applyResult), /requires Node\.js 24\.15 or later/);
    assert.equal(await readFile(sourcePath, "utf8"), source);
  } else {
    assert.equal(applyResult.status, 0, combined(applyResult));
    assert.match(applyResult.stdout, /ONCE LOCAL PROTECTION APPLIED/);
    assert.match(applyResult.stdout, /not a multi-host or universal exactly-once guarantee/);

    const applied = await readFile(sourcePath, "utf8");
    assert.match(applied, /protectLocal as __OnceProtectLocal/);
    assert.match(applied, /Once as __OnceAgentId/);
    assert.match(applied, /__OnceAgentId\.id\("create-order", orderId\)/);
    assert.match(applied, /provider\.createOrder\(\{ orderId, amountCents \}\)/);
    assert.notEqual(applied, source);
  }

  console.log("Local-function bridge public CLI regression: PASS");
} finally {
  await rm(temp, { recursive: true, force: true });
}

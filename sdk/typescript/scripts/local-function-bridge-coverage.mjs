import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "dist", "cli.js");
const temp = path.join(root, ".local-function-bridge-coverage-temp");

const fixtures = [
  {
    id: "cu3-order-wrapper",
    file: "cu3-order-wrapper.mjs",
    contractIntended: true,
    source: [
      "export const provider = {",
      "  async createOrder({ orderId, amountCents }) {",
      "    return { orderId, amountCents, status: \"created\" };",
      "  }",
      "};",
      "",
      "export const createOrder = async ({ orderId, amountCents }) =>",
      "  provider.createOrder({ orderId, amountCents });",
      ""
    ].join("\n")
  },
  {
    id: "neutral-name-order-wrapper",
    file: "neutral-name-order-wrapper.mjs",
    contractIntended: true,
    source: [
      "export const submit = async ({ orderId, amountCents }) =>",
      "  provider.createOrder({ orderId, amountCents });",
      ""
    ].join("\n")
  },
  {
    id: "block-body",
    file: "block-body.mjs",
    contractIntended: false,
    source: [
      "export const submit = async ({ orderId, amountCents }) => {",
      "  return provider.createOrder({ orderId, amountCents });",
      "};",
      ""
    ].join("\n")
  },
  {
    id: "multiple-effects",
    file: "multiple-effects.mjs",
    contractIntended: false,
    source: [
      "export const submit = async ({ orderId, amountCents }) => {",
      "  await provider.createOrder({ orderId, amountCents });",
      "  return provider.createOrder({ orderId: `${orderId}-second`, amountCents });",
      "};",
      ""
    ].join("\n")
  },
  {
    id: "plain-js-module-mode",
    file: "plain-js-module-mode.js",
    contractIntended: false,
    source: [
      "export const submit = async ({ orderId, amountCents }) =>",
      "  provider.createOrder({ orderId, amountCents });",
      ""
    ].join("\n")
  },
  {
    id: "default-destructured-value",
    file: "default-destructured-value.mjs",
    contractIntended: false,
    source: [
      "export const submit = async ({ orderId, amountCents = 100 }) =>",
      "  provider.createOrder({ orderId, amountCents });",
      ""
    ].join("\n")
  },
  {
    id: "provider-handle-parameter",
    file: "provider-handle-parameter.mjs",
    contractIntended: false,
    source: [
      "export const submit = async ({ provider, orderId, amountCents }) =>",
      "  provider.createOrder({ orderId, amountCents });",
      ""
    ].join("\n")
  },
  {
    id: "non-booking-category",
    file: "non-booking-category.mjs",
    contractIntended: false,
    source: [
      "export const submit = async ({ messageId, body }) =>",
      "  provider.sendMessage({ messageId, body });",
      ""
    ].join("\n")
  },
  {
    id: "aliased-destructuring",
    file: "aliased-destructuring.mjs",
    contractIntended: false,
    source: [
      "export const submit = async ({ orderId: id, amountCents }) =>",
      "  provider.createOrder({ orderId: id, amountCents });",
      ""
    ].join("\n")
  },
  {
    id: "rest-destructuring",
    file: "rest-destructuring.mjs",
    contractIntended: false,
    source: [
      "export const submit = async ({ orderId, ...rest }) =>",
      "  provider.createOrder({ orderId, amountCents: rest.amountCents });",
      ""
    ].join("\n")
  }
];

await rm(temp, { recursive: true, force: true });
await mkdir(temp, { recursive: true });

try {
  const before = new Map();

  for (const fixture of fixtures) {
    const filePath = path.join(temp, fixture.file);
    await writeFile(filePath, fixture.source, "utf8");
    before.set(fixture.file, await readFile(filePath, "utf8"));
  }

  const result = spawnSync(
    process.execPath,
    [cli, "protect", temp, "--all", "--write-plan"],
    { cwd: root, encoding: "utf8" }
  );

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error("Local-function bridge coverage benchmark failed to run Protect");
  }

  const plan = JSON.parse(
    await readFile(path.join(temp, ".once", "protect-plan.json"), "utf8")
  );

  assert.equal(plan.provider, null, "baseline must not configure a provider");
  assert.equal(plan.source_modified, false, "Protect baseline must remain read-only");

  const normalizedFile = value => value.replaceAll("\\", "/");
  const candidatesFor = fixture =>
    plan.candidates.filter(candidate =>
      normalizedFile(candidate.file).endsWith(`/${fixture.file}`) ||
      normalizedFile(candidate.file) === fixture.file
    );

  const results = fixtures.map(fixture => {
    const candidates = candidatesFor(fixture);

    assert.ok(
      candidates.length > 0,
      `${fixture.id}: expected the existing scanner to detect a consequential candidate`
    );

    for (const candidate of candidates) {
      assert.equal(
        candidate.auto_apply_eligible,
        false,
        `${fixture.id}: current baseline must not auto-apply local-function protection`
      );
      assert.notEqual(
        candidate.automation_status,
        "PATCHABLE",
        `${fixture.id}: current baseline unexpectedly became PATCHABLE`
      );
    }

    if (fixture.contractIntended) {
      assert.ok(
        candidates.some(candidate => candidate.category === "BOOKING"),
        `${fixture.id}: contract-intended fixture must currently be discovered as BOOKING`
      );
      assert.ok(
        candidates
          .filter(candidate => candidate.category === "BOOKING")
          .every(candidate => candidate.automation_status === "ADAPTER_REQUIRED"),
        `${fixture.id}: current BOOKING baseline must remain ADAPTER_REQUIRED`
      );
    }

    return {
      id: fixture.id,
      file: fixture.file,
      contractIntended: fixture.contractIntended,
      candidateCount: candidates.length,
      statuses: [...new Set(candidates.map(candidate => candidate.automation_status))].sort(),
      categories: [...new Set(candidates.map(candidate => candidate.category))].sort(),
      autoApplyEligible: candidates.some(candidate => candidate.auto_apply_eligible)
    };
  });

  for (const fixture of fixtures) {
    assert.equal(
      await readFile(path.join(temp, fixture.file), "utf8"),
      before.get(fixture.file),
      `${fixture.id}: benchmark must not modify application source`
    );
  }

  const totalFixtures = results.length;
  const contractIntended = results.filter(item => item.contractIntended).length;
  const currentAutoEligible = results.filter(item => item.autoApplyEligible).length;
  const rejectedByV1Contract = totalFixtures - contractIntended;
  const totalCandidates = results.reduce((sum, item) => sum + item.candidateCount, 0);

  assert.equal(totalFixtures, 10);
  assert.equal(contractIntended, 2);
  assert.equal(rejectedByV1Contract, 8);
  assert.equal(currentAutoEligible, 0);

  console.log("");
  console.log("LOCAL-FUNCTION BRIDGE BASELINE");
  console.log("==============================");
  console.log(`Total representative fixtures:       ${totalFixtures}`);
  console.log(`V1 contract-intended fixtures:       ${contractIntended}`);
  console.log(`V1 contract-rejected fixtures:       ${rejectedByV1Contract}`);
  console.log(`Current Protect candidates observed: ${totalCandidates}`);
  console.log(`Current bridge auto-eligible files:  ${currentAutoEligible}`);
  console.log(`Current bridge coverage:             ${((currentAutoEligible / totalFixtures) * 100).toFixed(2)}%`);
  console.log("");
  console.log("Coverage is source-surface coverage, not an accuracy percentage.");
  console.log("");
  console.log("Fixture results:");

  for (const item of results) {
    console.log(
      `${item.contractIntended ? "INTENDED" : "REJECTED"}  ${item.id}` +
      `  candidates=${item.candidateCount}` +
      `  categories=${item.categories.join(",")}` +
      `  statuses=${item.statuses.join(",")}` +
      `  auto_apply=${item.autoApplyEligible ? "yes" : "no"}`
    );
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

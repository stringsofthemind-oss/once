import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

const contractPath = path.join(
  root,
  "docs",
  "once-execution-authority-contract-v1-draft.json",
);
const vectorsPath = path.join(
  root,
  "conformance",
  "once-execution-authority-v1-vectors.json",
);

const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const suite = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));

assert.equal(contract.schema_version, "once-execution-authority-v1-draft");
assert.equal(contract.status, "draft_non_runtime");
assert.equal(
  suite.contract_schema_version,
  contract.schema_version,
);

assert.deepEqual(Object.keys(contract.layers), [
  "identity",
  "authority",
  "intent",
  "effect",
]);

const requiredDecisions = [
  "EXECUTE",
  "REPLAY_CONFIRMED",
  "CONFLICT",
  "RECONCILE_REQUIRED",
  "REQUIRE_REAPPROVAL",
  "DENY_AUTHORITY",
  "DENY_BINDING",
  "DENY_STATE",
];

assert.deepEqual(Object.keys(contract.decisions), requiredDecisions);
assert.deepEqual(suite.decisions, requiredDecisions);

for (const [decision, rule] of Object.entries(contract.decisions)) {
  assert.equal(typeof rule.meaning, "string");
  assert.ok(rule.meaning.length > 0);

  if (decision === "EXECUTE") {
    assert.equal(rule.redispatch_allowed, true);
  } else {
    assert.equal(
      rule.redispatch_allowed,
      false,
      `${decision} must never authorize another external dispatch`,
    );
  }
}

assert.ok(contract.core_invariants.includes("UNKNOWN is never retry permission."));
assert.ok(
  contract.core_invariants.includes(
    "Every protected external write must traverse the admitted execution boundary.",
  ),
);
assert.match(
  contract.continuity.known_limit,
  /rolling back|older valid ledger/i,
);

assert.equal(suite.cases.length, 16);

for (const testCase of suite.cases) {
  assert.equal(typeof testCase.id, "string");
  assert.ok(testCase.id.length > 0);
  assert.equal(typeof testCase.description, "string");
  assert.ok(testCase.description.length > 0);

  for (const layer of ["identity", "authority", "intent", "effect"]) {
    assert.ok(
      testCase[layer] && typeof testCase[layer] === "object",
      `${testCase.id} missing ${layer} layer`,
    );
  }

  assert.ok(
    requiredDecisions.includes(testCase.expected?.decision),
    `${testCase.id} has unknown expected decision`,
  );

  const expectedRule = contract.decisions[testCase.expected.decision];
  assert.equal(
    testCase.expected.redispatch_allowed,
    expectedRule.redispatch_allowed,
    `${testCase.id} contradicts contract redispatch rule`,
  );
}

function byId(id) {
  const found = suite.cases.find(testCase => testCase.id === id);
  assert.ok(found, `missing vector: ${id}`);
  return found;
}

assert.equal(
  byId("payment_confirmed_retry_same_effect").expected.decision,
  "REPLAY_CONFIRMED",
);
assert.equal(
  byId("payment_retry_changed_amount").expected.decision,
  "CONFLICT",
);
assert.equal(
  byId("booking_lost_ack_truth_unavailable").expected.decision,
  "RECONCILE_REQUIRED",
);
assert.equal(
  byId("booking_lost_ack_truth_unavailable").expected.redispatch_allowed,
  false,
);
assert.equal(
  byId("wrong_provider_account").expected.decision,
  "DENY_AUTHORITY",
);
assert.equal(
  byId("approval_scope_changed").expected.decision,
  "REQUIRE_REAPPROVAL",
);
assert.equal(
  byId("missing_effect_currency").expected.decision,
  "DENY_BINDING",
);
assert.equal(
  byId("model_generated_fresh_id_after_unknown").expected.decision,
  "DENY_BINDING",
);
assert.equal(
  byId("older_valid_history_detected").expected.decision,
  "DENY_STATE",
);
assert.equal(
  byId("nondefinitive_absence_after_ambiguous_attempt").expected.decision,
  "RECONCILE_REQUIRED",
);
assert.equal(
  byId("new_intent_same_payload").expected.decision,
  "EXECUTE",
);

const serialized = JSON.stringify({ contract, suite }).toLowerCase();

for (const forbidden of [
  "\"authorization\":",
  "\"bearer\":",
  "\"password\":",
  "\"private_key\":",
  "\"access_token\":",
]) {
  assert.equal(
    serialized.includes(forbidden),
    false,
    `contract fixtures must not model raw secret fields: ${forbidden}`,
  );
}

console.log(
  `Execution authority v1 draft regression: PASS (${suite.cases.length} vectors)`,
);

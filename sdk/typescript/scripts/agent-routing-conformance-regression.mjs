import assert from "node:assert/strict";

import {
  buildPerfectTrace,
  emitBlindCases,
  evaluateRoutingTrace,
  loadCanonicalSuite,
  validateCanonicalSuite
} from "./agent-routing-conformance.mjs";

const suite = await loadCanonicalSuite();
const summary = validateCanonicalSuite(suite);

assert.equal(summary.cases, 17);
assert.equal(summary.bypass, 8);
assert.equal(summary.evaluate, 9);
assert.equal(summary.runtimeStateCases, 3);

const blind = emitBlindCases(suite);
const blindSerialized = JSON.stringify(blind);

assert.equal(blind.schema_version, "once-agent-routing-cases-v1");
assert.equal(blind.cases.length, suite.cases.length);
assert.equal(blindSerialized.includes('"expected"'), false);
assert.equal(blindSerialized.includes('"conditions"'), false);
assert.equal(blindSerialized.includes("future freshness / has_changed"), false);

const freshnessBlindCase = blind.cases.find(
  testCase => testCase.case_id === "poll_npm_package_version"
);
assert.ok(freshnessBlindCase);
assert.equal(freshnessBlindCase.runtime_state, undefined);

const perfect = buildPerfectTrace(suite);
const perfectResult = evaluateRoutingTrace(suite, perfect);

assert.equal(perfectResult.pass, true);
assert.equal(perfectResult.passed, suite.cases.length);
assert.equal(perfectResult.overRoutes.length, 0);
assert.equal(perfectResult.underRoutes.length, 0);
assert.equal(perfectResult.actionMismatches.length, 0);
assert.equal(perfectResult.runtimeStateMismatches.length, 0);

const overRouteTrace = structuredClone(perfect);
const readDecision = overRouteTrace.decisions.find(
  decision => decision.case_id === "read_public_docs"
);
assert.ok(readDecision);
readDecision.route = "EVALUATE_ONCE";
readDecision.action = "PROTECT";

const overRouteResult = evaluateRoutingTrace(suite, overRouteTrace);
assert.equal(overRouteResult.pass, false);
assert.deepEqual(overRouteResult.overRoutes, ["read_public_docs"]);

const underRouteTrace = structuredClone(perfect);
const refundDecision = underRouteTrace.decisions.find(
  decision => decision.case_id === "create_refund"
);
assert.ok(refundDecision);
refundDecision.route = "BYPASS_ONCE";
refundDecision.action = "DIRECT";

const underRouteResult = evaluateRoutingTrace(suite, underRouteTrace);
assert.equal(underRouteResult.pass, false);
assert.deepEqual(underRouteResult.underRoutes, ["create_refund"]);

const unknownTrace = structuredClone(perfect);
const unknownDecision = unknownTrace.decisions.find(
  decision => decision.case_id === "refund_timeout_truth_unavailable"
);
assert.ok(unknownDecision);
unknownDecision.action = "EXECUTE";

const unknownResult = evaluateRoutingTrace(suite, unknownTrace);
assert.equal(unknownResult.pass, false);
assert.deepEqual(
  unknownResult.actionMismatches,
  ["refund_timeout_truth_unavailable"]
);

const freshnessAnswer = perfect.decisions.find(
  decision => decision.case_id === "poll_npm_package_version"
);
assert.ok(freshnessAnswer);
assert.equal(freshnessAnswer.route, "BYPASS_ONCE");
assert.equal(freshnessAnswer.action, "DIRECT");

const confirmedDecision = perfect.decisions.find(
  decision => decision.case_id === "booking_retry_prior_confirmed"
);
assert.ok(confirmedDecision);
assert.equal(confirmedDecision.runtime_state, "CONFIRMED");
assert.equal(confirmedDecision.action, "REPLAY_OR_SUPPRESS");

const absentDecision = perfect.decisions.find(
  decision => decision.case_id === "order_first_attempt_absent"
);
assert.ok(absentDecision);
assert.equal(absentDecision.runtime_state, "ABSENT");
assert.equal(absentDecision.action, "EXECUTE");

console.log("Agent routing conformance regression: PASS");

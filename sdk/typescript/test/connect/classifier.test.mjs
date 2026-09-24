import assert from "node:assert/strict";
import test from "node:test";

import {
  CONNECT_DECISION,
  classifyConnectOperation,
} from "../../src/connect/classifier.js";

test("protects only when all four Once routing conditions hold", () => {
  const result = classifyConnectOperation({
    changesExternalState: true,
    retryPossible: true,
    ambiguousOutcomePossible: true,
    duplicateUndesirable: true,
  });

  assert.equal(result.decision, CONNECT_DECISION.PROTECT);
  assert.equal(result.reason, "CONSEQUENTIAL_RETRY_RISK");
});

test("read-only work bypasses protection", () => {
  const result = classifyConnectOperation({
    changesExternalState: false,
    retryPossible: true,
    ambiguousOutcomePossible: true,
    duplicateUndesirable: true,
  });

  assert.equal(result.decision, CONNECT_DECISION.BYPASS);
});

test("non-retryable work bypasses protection", () => {
  const result = classifyConnectOperation({
    changesExternalState: true,
    retryPossible: false,
    ambiguousOutcomePossible: true,
    duplicateUndesirable: true,
  });

  assert.equal(result.decision, CONNECT_DECISION.BYPASS);
});

test("unambiguous outcomes bypass protection", () => {
  const result = classifyConnectOperation({
    changesExternalState: true,
    retryPossible: true,
    ambiguousOutcomePossible: false,
    duplicateUndesirable: true,
  });

  assert.equal(result.decision, CONNECT_DECISION.BYPASS);
});

test("harmless duplicate execution bypasses protection", () => {
  const result = classifyConnectOperation({
    changesExternalState: true,
    retryPossible: true,
    ambiguousOutcomePossible: true,
    duplicateUndesirable: false,
  });

  assert.equal(result.decision, CONNECT_DECISION.BYPASS);
});

test("missing safety declarations fail closed", () => {
  const result = classifyConnectOperation({
    changesExternalState: true,
  });

  assert.equal(result.decision, CONNECT_DECISION.REJECT);
  assert.equal(result.reason, "INCOMPLETE_SAFETY_DECLARATION");
});

test("non-boolean safety declarations fail closed", () => {
  const result = classifyConnectOperation({
    changesExternalState: true,
    retryPossible: true,
    ambiguousOutcomePossible: "maybe",
    duplicateUndesirable: true,
  });

  assert.equal(result.decision, CONNECT_DECISION.REJECT);
});

test("invalid operation input fails closed", () => {
  assert.equal(
    classifyConnectOperation(null).decision,
    CONNECT_DECISION.REJECT,
  );

  assert.equal(
    classifyConnectOperation([]).decision,
    CONNECT_DECISION.REJECT,
  );
});

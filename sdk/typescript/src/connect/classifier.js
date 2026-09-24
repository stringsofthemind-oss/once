export const CONNECT_DECISION = Object.freeze({
  PROTECT: "PROTECT",
  BYPASS: "BYPASS",
  REJECT: "REJECT",
});

function requireBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new TypeError(`Once Connect requires boolean "${name}".`);
  }
}

export function classifyConnectOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return Object.freeze({
      decision: CONNECT_DECISION.REJECT,
      reason: "INVALID_OPERATION",
    });
  }

  const {
    changesExternalState,
    retryPossible,
    ambiguousOutcomePossible,
    duplicateUndesirable,
  } = operation;

  try {
    requireBoolean(changesExternalState, "changesExternalState");
    requireBoolean(retryPossible, "retryPossible");
    requireBoolean(
      ambiguousOutcomePossible,
      "ambiguousOutcomePossible",
    );
    requireBoolean(
      duplicateUndesirable,
      "duplicateUndesirable",
    );
  } catch {
    return Object.freeze({
      decision: CONNECT_DECISION.REJECT,
      reason: "INCOMPLETE_SAFETY_DECLARATION",
    });
  }

  const requiresProtection =
    changesExternalState &&
    retryPossible &&
    ambiguousOutcomePossible &&
    duplicateUndesirable;

  if (requiresProtection) {
    return Object.freeze({
      decision: CONNECT_DECISION.PROTECT,
      reason: "CONSEQUENTIAL_RETRY_RISK",
    });
  }

  return Object.freeze({
    decision: CONNECT_DECISION.BYPASS,
    reason: "PROTECTION_CONDITIONS_NOT_ALL_PRESENT",
  });
}

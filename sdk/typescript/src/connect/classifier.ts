export const CONNECT_DECISION = Object.freeze({
  PROTECT: "PROTECT",
  BYPASS: "BYPASS",
  REJECT: "REJECT",
} as const);

export type ConnectDecision =
  (typeof CONNECT_DECISION)[keyof typeof CONNECT_DECISION];

export interface ConnectSafetyDeclaration {
  changesExternalState: boolean;
  retryPossible: boolean;
  ambiguousOutcomePossible: boolean;
  duplicateUndesirable: boolean;
}

export interface ConnectClassification {
  decision: ConnectDecision;
  reason:
    | "INVALID_OPERATION"
    | "INCOMPLETE_SAFETY_DECLARATION"
    | "CONSEQUENTIAL_RETRY_RISK"
    | "PROTECTION_CONDITIONS_NOT_ALL_PRESENT";
}

function requireBoolean(
  value: unknown,
  name: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(
      `Once Connect requires boolean "${name}".`,
    );
  }
}

export function classifyConnectOperation(
  operation: unknown,
): Readonly<ConnectClassification> {
  if (
    !operation ||
    typeof operation !== "object" ||
    Array.isArray(operation)
  ) {
    return Object.freeze({
      decision: CONNECT_DECISION.REJECT,
      reason: "INVALID_OPERATION",
    });
  }

  const candidate =
    operation as Record<string, unknown>;

  const {
    changesExternalState,
    retryPossible,
    ambiguousOutcomePossible,
    duplicateUndesirable,
  } = candidate;

  try {
    requireBoolean(
      changesExternalState,
      "changesExternalState",
    );

    requireBoolean(
      retryPossible,
      "retryPossible",
    );

    requireBoolean(
      ambiguousOutcomePossible,
      "ambiguousOutcomePossible",
    );

    requireBoolean(
      duplicateUndesirable,
      "duplicateUndesirable",
    );
  }
  catch {
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

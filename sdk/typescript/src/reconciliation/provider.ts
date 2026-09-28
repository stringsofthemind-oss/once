import {
  fingerprintConnectPayload,
} from "../connect/binding.js";

import type {
  LocalObservation,
} from "../local.js";

type JsonObject =
  Record<string, unknown>;

export type ProviderReconciliationContext = Readonly<{
  id: string;
  payload: JsonObject;
}>;

export type ProviderLookup<Result> =
  | Readonly<{
      kind: "FOUND";
      operationId: string;
      payload: JsonObject;
      result: Result;
      source?: string;
    }>
  | Readonly<{
      kind: "ABSENT_PROVEN";
      source?: string;
      detail?: string;
    }>
  | Readonly<{
      kind: "UNKNOWN";
      source?: string;
      detail: string;
    }>;

export type ReconciliationEvidence<Result> =
  | Readonly<{
      state: "CONFIRMED";
      source: string;
      result: Result;
      operationId: string;
      effectFingerprint: string;
    }>
  | Readonly<{
      state: "ABSENT_PROVEN";
      source: string;
      detail?: string;
    }>
  | Readonly<{
      state: "MISMATCH";
      source: string;
      reason: "OPERATION_ID_MISMATCH" | "EFFECT_PAYLOAD_MISMATCH";
      expectedOperationId: string;
      observedOperationId: string;
      expectedEffectFingerprint?: string;
      observedEffectFingerprint?: string;
    }>
  | Readonly<{
      state: "UNKNOWN";
      source: string;
      detail: string;
    }>;

export interface ProviderReconciliationAdapter<Result> {
  /** Read-only provider-truth inspection. It must never execute the protected effect. */
  inspect(
    context: ProviderReconciliationContext,
  ): Promise<ReconciliationEvidence<Result>>;

  /**
   * Compatibility callback for protectLocal / Connect.
   * CONFIRMED is replayable. ABSENT_PROVEN is surfaced as ABSENT evidence, while
   * MISMATCH and UNKNOWN remain UNKNOWN. Local protection still never redispatches
   * after an ambiguous attempt.
   */
  reconcile(
    context: ProviderReconciliationContext,
  ): Promise<LocalObservation<Result>>;
}

export interface CreateProviderReconciliationAdapterOptions<Result> {
  /** Human-readable authority label, for example `billing-status-api`. */
  source: string;

  /**
   * Read-only provider lookup. ABSENT_PROVEN may only be returned when the
   * provider contract makes absence authoritative for this exact operation ID.
   */
  lookup(
    context: ProviderReconciliationContext,
  ): Promise<ProviderLookup<Result>> | ProviderLookup<Result>;
}

function sourceLabel(
  fallback: string,
  candidate?: string,
): string {
  const value =
    candidate?.trim();

  return value || fallback;
}

export function evaluateProviderLookup<Result>(
  context: ProviderReconciliationContext,
  observation: ProviderLookup<Result>,
  fallbackSource = "provider-reconciliation",
): ReconciliationEvidence<Result> {
  const source =
    sourceLabel(
      fallbackSource,
      observation?.source,
    );

  if (
    !context ||
    typeof context.id !== "string" ||
    context.id.trim() === ""
  ) {
    return {
      state: "UNKNOWN",
      source,
      detail:
        "Provider truth cannot be evaluated without a stable nonempty operation ID.",
    };
  }

  if (
    !observation ||
    typeof observation !== "object"
  ) {
    return {
      state: "UNKNOWN",
      source,
      detail:
        "Provider lookup returned no usable observation.",
    };
  }

  if (observation.kind === "ABSENT_PROVEN") {
    return {
      state: "ABSENT_PROVEN",
      source,
      ...(observation.detail
        ? { detail: observation.detail }
        : {}),
    };
  }

  if (observation.kind === "UNKNOWN") {
    return {
      state: "UNKNOWN",
      source,
      detail:
        observation.detail ||
        "Provider lookup did not establish authoritative truth.",
    };
  }

  if (observation.kind !== "FOUND") {
    return {
      state: "UNKNOWN",
      source,
      detail:
        "Provider lookup returned an unsupported observation kind.",
    };
  }

  if (observation.operationId !== context.id) {
    return {
      state: "MISMATCH",
      source,
      reason: "OPERATION_ID_MISMATCH",
      expectedOperationId: context.id,
      observedOperationId: observation.operationId,
    };
  }

  let expectedEffectFingerprint: string;
  let observedEffectFingerprint: string;

  try {
    expectedEffectFingerprint =
      fingerprintConnectPayload(
        context.payload,
      );

    observedEffectFingerprint =
      fingerprintConnectPayload(
        observation.payload,
      );
  } catch {
    return {
      state: "UNKNOWN",
      source,
      detail:
        "Provider truth contained an effect payload that Once could not bind deterministically.",
    };
  }

  if (
    observedEffectFingerprint !==
    expectedEffectFingerprint
  ) {
    return {
      state: "MISMATCH",
      source,
      reason: "EFFECT_PAYLOAD_MISMATCH",
      expectedOperationId: context.id,
      observedOperationId: observation.operationId,
      expectedEffectFingerprint,
      observedEffectFingerprint,
    };
  }

  return {
    state: "CONFIRMED",
    source,
    result: observation.result,
    operationId: context.id,
    effectFingerprint:
      expectedEffectFingerprint,
  };
}

export function reconciliationEvidenceToLocalObservation<Result>(
  evidence: ReconciliationEvidence<Result>,
): LocalObservation<Result> {
  if (evidence.state === "CONFIRMED") {
    return {
      state: "CONFIRMED",
      result: evidence.result,
    };
  }

  if (evidence.state === "ABSENT_PROVEN") {
    return {
      state: "ABSENT",
    };
  }

  return {
    state: "UNKNOWN",
  };
}

export function createProviderReconciliationAdapter<Result>(
  options: CreateProviderReconciliationAdapterOptions<Result>,
): ProviderReconciliationAdapter<Result> {
  if (
    !options ||
    typeof options.lookup !== "function" ||
    typeof options.source !== "string" ||
    options.source.trim() === ""
  ) {
    throw new Error(
      "A reconciliation adapter requires a nonempty source label and a read-only lookup callback.",
    );
  }

  const source =
    options.source.trim();

  const inspect =
    async (
      context: ProviderReconciliationContext,
    ): Promise<ReconciliationEvidence<Result>> => {
      try {
        const observation =
          await options.lookup(context);

        return evaluateProviderLookup(
          context,
          observation,
          source,
        );
      } catch (error) {
        return {
          state: "UNKNOWN",
          source,
          detail:
            error instanceof Error && error.message
              ? `Provider truth lookup failed: ${error.message}`
              : "Provider truth lookup failed.",
        };
      }
    };

  return Object.freeze({
    inspect,
    reconcile:
      async (
        context: ProviderReconciliationContext,
      ): Promise<LocalObservation<Result>> =>
        reconciliationEvidenceToLocalObservation(
          await inspect(context),
        ),
  });
}

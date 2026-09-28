import { randomUUID } from "node:crypto";

import {
  Once,
  type ExecuteResponse,
  type TruthResponse,
} from "./index.js";

import {
  inspectProtectionReceipt,
  markProtectionReceiptVerified,
  ONCE_SDK_EXECUTE_ROUTE,
  type VerifiedProtectionReceipt,
} from "./protection-receipt.js";

export type ProtectionRouteProofResult = Readonly<{
  passed: true;
  operationId: string;
  executeRequests: number;
  attempts: number;
  sideEffects: 1;
  ledgerState: "CONFIRMED";
  executeResponse: ExecuteResponse;
  truth: TruthResponse;
  receipt: VerifiedProtectionReceipt;
}>;

export interface ProtectionRouteProofOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  operationId?: string;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function requestMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  if (init?.method) {
    return String(init.method).toUpperCase();
  }

  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }

  return "GET";
}

/**
 * Verify the exact SDK route written by Phase 15C.
 *
 * The proof intentionally discards the first successful `/v1/execute` HTTP
 * acknowledgement *after* the server has responded. The SDK must then retry the
 * same stable operation ID. Once truth must report at least two attempts and
 * exactly one effect at the independent synthetic `blind_test` provider.
 *
 * This is the only networked Phase 15 proof path. Calling it is an explicit
 * opt-in and requires a valid Once API key. It never invokes the user's actual
 * configured provider or application target.
 */
export async function verifyProtectionRoute(
  requestedPath: string,
  options: ProtectionRouteProofOptions = {},
): Promise<ProtectionRouteProofResult> {
  const inspection = await inspectProtectionReceipt(requestedPath);

  if (!inspection) {
    throw new Error(
      "No protection receipt exists. Apply a supported transformation before route verification.",
    );
  }

  if (inspection.state === "INVALID_RECEIPT") {
    throw new Error(
      `Protection receipt is invalid: ${inspection.detail}`,
    );
  }

  if (inspection.state === "STALE_SOURCE") {
    throw new Error(
      `Protection receipt is stale: ${inspection.detail}`,
    );
  }

  if (inspection.state === "CURRENT_PROTECTED") {
    return {
      passed: true,
      operationId: inspection.receipt.route_proof.operation_id,
      executeRequests: inspection.receipt.route_proof.attempts,
      attempts: inspection.receipt.route_proof.attempts,
      sideEffects: 1,
      ledgerState: "CONFIRMED",
      executeResponse: {
        operation_id: inspection.receipt.route_proof.operation_id,
        result: "already_verified",
        state: "CONFIRMED",
      },
      truth: {
        operation_id: inspection.receipt.route_proof.operation_id,
        ledger_state: "CONFIRMED",
        attempts: inspection.receipt.route_proof.attempts,
        side_effects: 1,
      },
      receipt: inspection.receipt,
    };
  }

  if (inspection.receipt.execution_route !== ONCE_SDK_EXECUTE_ROUTE) {
    throw new Error(
      `Unsupported protection route: ${inspection.receipt.execution_route}`,
    );
  }

  const baseFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof baseFetch !== "function") {
    throw new Error("Route verification requires fetch support.");
  }

  const operationId =
    options.operationId ??
    `phase15-sdk-proof:${randomUUID().replaceAll("-", "")}`;

  let discardedFirstSuccess = false;
  let executeRequests = 0;

  const proofFetch: typeof fetch = async (
    input,
    init,
  ) => {
    const url = new URL(requestUrl(input));
    const method = requestMethod(input, init);

    const response = await baseFetch(input, init);

    if (
      url.pathname === "/v1/execute" &&
      method === "POST"
    ) {
      executeRequests++;

      if (!discardedFirstSuccess && response.ok) {
        // Drain a clone so this is unambiguously a lost acknowledgement after a
        // complete successful server response, not a request that may never
        // have reached Once.
        await response.clone().arrayBuffer();
        discardedFirstSuccess = true;
        throw new Error(
          "once_phase15_synthetic_lost_ack_after_success",
        );
      }
    }

    return response;
  };

  const once = new Once({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    fetchImpl: proofFetch,
    networkRetries: 1,
  });

  const executeResponse = await once.execute({
    operationId,
    provider: "blind_test",
    action: {
      type: "once_sdk_execute_route_proof_v1",
      synthetic: true,
    },
  });

  const truth = await once.truth(operationId);

  const attempts = Number(truth.attempts);
  const sideEffects = Number(truth.side_effects);

  if (!discardedFirstSuccess) {
    throw new Error(
      "Route proof did not discard a successful first acknowledgement.",
    );
  }

  if (executeRequests < 2) {
    throw new Error(
      `Route proof expected a retry after the lost acknowledgement; observed ${executeRequests} execute request(s).`,
    );
  }

  if (
    truth.ledger_state !== "CONFIRMED" ||
    !Number.isSafeInteger(attempts) ||
    attempts < 2 ||
    sideEffects !== 1 ||
    truth.provider_executed === false
  ) {
    throw new Error(
      "Route proof failed: Once truth did not show CONFIRMED with at least two attempts and exactly one synthetic provider effect.",
    );
  }

  const promoted = await markProtectionReceiptVerified(
    requestedPath,
    {
      operationId,
      attempts,
      sideEffects,
    },
  );

  return {
    passed: true,
    operationId,
    executeRequests,
    attempts,
    sideEffects: 1,
    ledgerState: "CONFIRMED",
    executeResponse,
    truth,
    receipt: promoted.receipt,
  };
}

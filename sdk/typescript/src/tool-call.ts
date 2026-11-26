import { fingerprintConnectPayload } from "./connect/binding.js";
import {
  LocalProtectionError, protectLocal, recordLocalApproval, runLocalOperation, snapshotLocalData,
  type LocalAdmissionWitness, type LocalLedgerMode,
} from "./local.js";

export interface ToolCallEffect<I extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable tool and authority identity. Include tenant/account where relevant. */
  readonly tool: string;
  /** Complete effect-bearing input; transport metadata belongs outside this object. */
  readonly args: I;
}

export type ToolCallObservation<T> =
  | { status: "CONFIRMED"; result: T }
  | { status: "NOT_FOUND" | "UNKNOWN" };

interface ToolCallRequest<I extends Record<string, unknown>, T> {
  operationId: string;
  effect: ToolCallEffect<I>;
  reconcile?: (context: {
    operationId: string;
    effect: ToolCallEffect<I>;
  }) => Promise<ToolCallObservation<T>> | ToolCallObservation<T>;
  statePath?: string;
}

export interface ToolCallProtectionOptions<I extends Record<string, unknown>, T> extends ToolCallRequest<I, T> {
  /** Receives a strict, deeply frozen snapshot of the fingerprinted effect. */
  execute: (effect: ToolCallEffect<I>) => Promise<T>;
  /** Ignored by identity and fingerprinting. Must not change the external effect. */
  metadata?: unknown;
  ledgerMode?: LocalLedgerMode;
  leaseMs?: number;
}

export interface LocalToolIntent {
  /** Trusted tenant scope, provider account, and immutable approval identifier. */
  tenant: string;
  providerAccount: string;
  intentId: string;
}

function checkedEffect<I extends Record<string, unknown>>(input: ToolCallEffect<I>): ToolCallEffect<I> {
  const effect = snapshotLocalData(input);
  if (!effect || typeof effect !== "object" || Array.isArray(effect) ||
      typeof effect.tool !== "string" || !effect.tool.trim() ||
      !effect.args || typeof effect.args !== "object" || Array.isArray(effect.args) ||
      Object.keys(effect).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(effect, "tool") ||
      !Object.prototype.hasOwnProperty.call(effect, "args")) {
    throw new LocalProtectionError("INVALID_EFFECT", "effect must contain only a nonempty tool identity and plain-data args; no tool was dispatched.");
  }
  return effect;
}

function effectPayload(effect: ToolCallEffect) {
  return { contract: "once-tool-call-v1", tool: effect.tool, args: effect.args };
}

function trustedIntent(input: LocalToolIntent): LocalToolIntent {
  const intent = snapshotLocalData(input);
  if (!intent || Object.keys(intent).length !== 3 ||
      ![intent.tenant, intent.providerAccount, intent.intentId].every(value =>
        typeof value === "string" && value.trim().length > 0 && value.length <= 512)) {
    throw new LocalProtectionError("INTENT_REQUIRED", "Supply a trusted tenant, provider account and approval identifier.");
  }
  return intent;
}

function operationIdForIntent(intent: LocalToolIntent): string {
  return "once-intent:" + fingerprintConnectPayload({
    contract: "once-local-intent-v1",
    tenant: intent.tenant,
    providerAccount: intent.providerAccount,
    intentId: intent.intentId,
  });
}

function requireManagedPath(statePath: string): string {
  if (typeof statePath !== "string" || !statePath.trim()) {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "Specify the original managed ledger path.");
  }
  return statePath;
}

function prepareToolCall<I extends Record<string, unknown>, T>(options: ToolCallRequest<I, T>) {
  if (typeof options?.operationId !== "string" || !options.operationId.trim()) {
    throw new LocalProtectionError("IDENTITY_REQUIRED", "An explicit stable operationId is required; no tool was dispatched.");
  }
  const { operationId, reconcile, statePath } = options;
  if (reconcile !== undefined && typeof reconcile !== "function") {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "The optional provider lookup must be callable.");
  }
  const effect = checkedEffect(options.effect);
  return {
    effect,
    statePath,
    id: () => operationId,
    payload: () => effectPayload(effect),
    reconcile: reconcile ? async () => {
      const observation = snapshotLocalData(await reconcile({ operationId, effect }));
      if (observation && typeof observation === "object" && !Array.isArray(observation) &&
          Object.keys(observation).length === 2 &&
          Object.prototype.hasOwnProperty.call(observation, "status") &&
          observation.status === "CONFIRMED" &&
          Object.prototype.hasOwnProperty.call(observation, "result")) {
        return { state: "CONFIRMED" as const, result: observation.result };
      }
      return { state: observation?.status === "NOT_FOUND" ? "ABSENT" as const : "UNKNOWN" as const };
    } : undefined,
  };
}

/** Protect a host-supplied callable using the existing local durable authority. */
export async function protectToolCall<I extends Record<string, unknown>, T>(
  options: ToolCallProtectionOptions<I, T>,
): Promise<T> {
  const request = prepareToolCall(options);
  const { execute, leaseMs, ledgerMode } = options;
  if (typeof execute !== "function") {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "execute must be callable; no tool was dispatched.");
  }
  return protectLocal<[], T>(() => execute(request.effect), { ...request, leaseMs, ledgerMode })();
}

/** Reconcile a recorded legacy tool call without a dispatch callback or a fresh claim. */
export async function reconcileToolCall<I extends Record<string, unknown>, T>(
  options: ToolCallRequest<I, T>,
): Promise<T> {
  return runLocalOperation<[], T>(undefined, prepareToolCall(options), "reconcile")();
}

/** Persist a separately approved intent. Only trusted host policy may call this API. */
export async function approveLocalToolIntent<I extends Record<string, unknown>>(options: {
  statePath: string;
  intent: LocalToolIntent;
  effect: ToolCallEffect<I>;
  /** Optional short, non-sensitive description for operators. */
  label?: string;
  /** Optional non-sensitive team alias for unresolved cases. */
  assignedTo?: string;
}): Promise<string> {
  const { statePath, intent, label, assignedTo } = options;
  for (const value of [label, assignedTo]) {
    if (value !== undefined && (typeof value !== "string" || !value.trim() ||
        value.length > 160 || /[\p{C}]/u.test(value))) {
      throw new LocalProtectionError("INVALID_CONFIGURATION", "Use short, non-sensitive operator labels without control characters.");
    }
  }
  const operationId = operationIdForIntent(trustedIntent(intent));
  const fingerprint = fingerprintConnectPayload(effectPayload(checkedEffect(options.effect)));
  await recordLocalApproval(requireManagedPath(statePath), operationId, fingerprint, label, assignedTo);
  return operationId;
}

type ApprovedToolRequest<I extends Record<string, unknown>, T> =
  Omit<ToolCallRequest<I, T>, "operationId" | "statePath"> & { statePath: string; intent: LocalToolIntent };

/** Execute only a durable, previously approved intent selected by the trusted host. */
export async function executeApprovedLocalTool<I extends Record<string, unknown>, T>(
  options: ApprovedToolRequest<I, T> & {
    execute: (effect: ToolCallEffect<I>, context: {
      operationId: string;
      intent: Readonly<LocalToolIntent>;
    }) => Promise<T>;
    leaseMs?: number;
    witness?: LocalAdmissionWitness;
  },
): Promise<T> {
  const { witness, leaseMs, execute } = options;
  const intent = trustedIntent(options.intent);
  const operationId = operationIdForIntent(intent);
  if (typeof execute !== "function") {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "execute must be callable; no tool was dispatched.");
  }
  const request = prepareToolCall({ ...options, statePath: requireManagedPath(options.statePath), operationId });
  return runLocalOperation<[], T>(() => execute(request.effect, { operationId, intent }),
    { ...request, leaseMs, witness }, "approved")();
}

/** Reconcile an approved, recorded dispatch without accepting an execute callback. */
export async function reconcileApprovedLocalTool<I extends Record<string, unknown>, T>(
  options: ApprovedToolRequest<I, T>,
): Promise<T> {
  return runLocalOperation<[], T>(undefined,
    prepareToolCall({
      ...options,
      statePath: requireManagedPath(options.statePath),
      operationId: operationIdForIntent(trustedIntent(options.intent)),
    }),
    "reconcile-approved",
  )();
}

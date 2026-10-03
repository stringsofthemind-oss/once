import { LocalProtectionError, protectLocal, snapshotLocalData } from "./local.js";

export interface ToolCallEffect<I extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable tool and authority identity. Include tenant/account where relevant. */
  readonly tool: string;
  /** Complete effect-bearing input; transport metadata belongs outside this object. */
  readonly args: I;
}

export type ToolCallObservation<T> =
  | { status: "CONFIRMED"; result: T }
  | { status: "NOT_FOUND" | "UNKNOWN" };

export interface ToolCallProtectionOptions<I extends Record<string, unknown>, T> {
  operationId: string;
  effect: ToolCallEffect<I>;
  /** Receives a strict, deeply frozen snapshot of the fingerprinted effect. */
  execute: (effect: ToolCallEffect<I>) => Promise<T>;
  reconcile?: (context: {
    operationId: string;
    effect: ToolCallEffect<I>;
  }) => Promise<ToolCallObservation<T>> | ToolCallObservation<T>;
  /** Ignored by identity and fingerprinting. Must not change the external effect. */
  metadata?: unknown;
  statePath?: string;
  leaseMs?: number;
}

/** Protect a host-supplied callable using the existing local durable authority. */
export async function protectToolCall<I extends Record<string, unknown>, T>(
  options: ToolCallProtectionOptions<I, T>,
): Promise<T> {
  if (typeof options?.operationId !== "string" || !options.operationId.trim()) {
    throw new LocalProtectionError("IDENTITY_REQUIRED", "protectToolCall requires an explicit stable operationId; no tool was dispatched.");
  }
  const { operationId, execute, reconcile, statePath, leaseMs } = options;
  if (typeof execute !== "function" || (reconcile !== undefined && typeof reconcile !== "function")) {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "execute and optional reconcile must be callable; no tool was dispatched.");
  }
  const effect = snapshotLocalData(options.effect);
  if (!effect || typeof effect !== "object" || Array.isArray(effect) ||
      typeof effect.tool !== "string" || !effect.tool.trim() ||
      !effect.args || typeof effect.args !== "object" || Array.isArray(effect.args) ||
      Object.keys(effect).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(effect, "tool") ||
      !Object.prototype.hasOwnProperty.call(effect, "args")) {
    throw new LocalProtectionError("INVALID_EFFECT", "effect must contain only a nonempty tool identity and plain-data args; no tool was dispatched.");
  }
  const run = protectLocal<[], T>(async () => execute(effect), {
    id: () => operationId,
    // A version tag prevents accidental receipt reuse across protection contracts.
    payload: () => ({ contract: "once-tool-call-v1", tool: effect.tool, args: effect.args }),
    statePath,
    leaseMs,
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
  });
  return run();
}

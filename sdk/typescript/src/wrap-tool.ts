import { LocalProtectionError, snapshotLocalData } from "./local.js";
import { protectToolCall, type ToolCallEffect, type ToolCallProtectionOptions } from "./tool-call.js";

export interface WrapToolOptions<Input extends Record<string, unknown>, Args extends Record<string, unknown>, Result> {
  /** Application-owned stable logical identity; never a transport call ID. */
  operationId: (input: Input) => string;
  /** Complete tool/authority binding and the exact arguments passed to the callback. */
  effect: (input: Input) => ToolCallEffect<Args>;
  reconcile?: ToolCallProtectionOptions<Args, Result>["reconcile"];
  statePath?: string;
  leaseMs?: number;
}

/**
 * Replace a host-owned unary callback. The callback receives frozen effect.args,
 * not the original input. Bind methods when needed; receiver/closure authority
 * must be fixed or explicitly represented in the effect. Internal callback
 * retries are outside this boundary. Requires Node 24.15+ and shared local state.
 */
export function wrapTool<Args extends Record<string, unknown>, Result, Input extends Record<string, unknown> = Args, Receiver = unknown>(
  callback: (this: Receiver, args: Args) => Promise<Result>,
  options: WrapToolOptions<Input, Args, Result>,
): (this: Receiver, input: Input) => Promise<Result> {
  if (typeof callback !== "function" || typeof options?.operationId !== "function" ||
      typeof options.effect !== "function" ||
      (options.reconcile !== undefined && typeof options.reconcile !== "function")) {
    throw new LocalProtectionError("INVALID_CONFIGURATION", "wrapTool requires a callback and explicit operationId/effect selectors; no tool was dispatched.");
  }
  const { operationId, effect, reconcile, statePath, leaseMs } = options;
  return async function (this: Receiver, input: Input): Promise<Result> {
    const snapshot = snapshotLocalData(input);
    return protectToolCall({
      operationId: operationId(snapshot),
      effect: effect(snapshot),
      execute: ({ args }) => callback.call(this, args),
      reconcile,
      statePath,
      leaseMs,
    });
  };
}

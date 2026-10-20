import type { ExecutionAuthority } from "./execution-store.js";
import { LocalProtectionError, snapshotLocalData } from "./local.js";
import { fingerprintConnectPayload } from "./connect/binding.js";
import type { ToolCallEffect } from "./tool-call.js";
import { createHash } from "node:crypto";

export const HOST_INTENT_AUTHORITY_CONTRACT = "once-host-intent-v2" as const;
/** For explicitly authorized NEW empty namespaces only; never recovery seeding. */
export const EMPTY_HOST_AUTHORITY_DIGEST = createHash("sha256").update(JSON.stringify({ contract: "once-authority-state-v2", operations: [], intents: [] })).digest("hex");

/** Created by a trusted host BEFORE tool execution, never by planner IDs/hashes. */
export interface HostIntentBinding {
  readonly scope: string;
  readonly intentKey: string;
  readonly operationId: string;
  readonly effectFingerprint: string;
}
export interface HostIntentRequest { scope: string; intentKey: string; effect: ToolCallEffect }
export interface HostIntentAuthority extends ExecutionAuthority {
  readonly contract: typeof HOST_INTENT_AUTHORITY_CONTRACT;
  /** Lookup only. Missing history is a denial, never implicit admission. */
  resolveIntent(scope: string, intentKey: string): Promise<HostIntentBinding>;
}
export function hostIntentEffectFingerprint(effect: ToolCallEffect): string {
  const value = snapshotLocalData(effect);
  if (!value || Object.keys(value).sort().join(",") !== "args,tool" ||
      typeof value.tool !== "string" || !value.tool.trim() || !value.args ||
      typeof value.args !== "object" || Array.isArray(value.args)) {
    throw new LocalProtectionError("INVALID_EFFECT", "Host intent needs the complete explicit tool effect.");
  }
  return fingerprintConnectPayload(value as unknown as Record<string, unknown>);
}

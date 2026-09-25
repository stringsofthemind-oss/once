import {
  CONNECT_TOOL_DECISION,
  classifyConnectTool,
  type ConnectToolClassificationReason,
  type ConnectToolDescriptor,
} from "./tool-classifier.js";
import {
  resolveConnectToolOperationIdentity,
  type ConnectIdentitySource,
} from "./identity.js";
import {
  resolveConnectToolEffectPayload,
  type ConnectPayloadSource,
} from "./payload.js";
import {
  bindConnectOperation,
  canonicalizeConnectPayload,
  type ConnectPayload,
} from "./binding.js";

export const CONNECT_PREFLIGHT_VERSION = "connect-tool-preflight-v1" as const;

export type ConnectToolPreflightDecision =
  | "BYPASS"
  | "PROTECT"
  | "BLOCK";

export type ConnectToolPreflightCode =
  | "TOOL_BYPASS"
  | "TOOL_PROTECT"
  | "TOOL_SAFETY_UNKNOWN"
  | "IDENTITY_REQUIRED"
  | "IDENTITY_CONFLICT"
  | "PAYLOAD_REQUIRED";

export type ConnectPreflightPayloadSource =
  | "explicit"
  | ConnectPayloadSource;

export interface PrepareConnectToolCallInput {
  descriptor: ConnectToolDescriptor;
  input: unknown;
  explicitIdentity?: string;
  payload?: ConnectPayload;
}

export interface ConnectToolPreflightResult {
  version: typeof CONNECT_PREFLIGHT_VERSION;
  decision: ConnectToolPreflightDecision;
  code: ConnectToolPreflightCode;
  consequential: boolean;
  reason: string;
  classificationReason: ConnectToolClassificationReason;
  operationId?: string;
  identitySource?: ConnectIdentitySource;
  payload?: Readonly<ConnectPayload>;
  payloadSource?: ConnectPreflightPayloadSource;
  payloadFingerprint?: string;
}

function frozenPayload(
  value: ConnectPayload,
): Readonly<ConnectPayload> | null {
  try {
    return Object.freeze(
      JSON.parse(canonicalizeConnectPayload(value)) as ConnectPayload,
    );
  } catch {
    return null;
  }
}

function freezeResult(
  result: ConnectToolPreflightResult,
): Readonly<ConnectToolPreflightResult> {
  return Object.freeze({
    ...result,
    ...(result.payload
      ? { payload: Object.freeze({ ...result.payload }) }
      : {}),
  });
}

/**
 * Prepare one agent/tool call for safe routing without performing I/O.
 *
 * This is the framework-neutral call-time gate for Connect:
 * - obvious read/generation work -> BYPASS;
 * - consequential work with trustworthy identity + effect payload -> PROTECT;
 * - uncertainty about tool safety, identity, or payload -> BLOCK.
 *
 * The function is deterministic and local. It never executes the underlying
 * tool and never converts uncertainty into permission.
 */
export function prepareConnectToolCall(
  request: PrepareConnectToolCallInput,
): Readonly<ConnectToolPreflightResult> {
  const classification = classifyConnectTool(request?.descriptor);

  if (classification.decision === CONNECT_TOOL_DECISION.BYPASS) {
    return freezeResult({
      version: CONNECT_PREFLIGHT_VERSION,
      decision: "BYPASS",
      code: "TOOL_BYPASS",
      consequential: false,
      reason: "Tool semantics do not require Once duplicate-effect protection.",
      classificationReason: classification.reason,
    });
  }

  if (classification.decision === CONNECT_TOOL_DECISION.UNKNOWN) {
    return freezeResult({
      version: CONNECT_PREFLIGHT_VERSION,
      decision: "BLOCK",
      code: "TOOL_SAFETY_UNKNOWN",
      consequential: false,
      reason: `Once Connect cannot safely classify this tool: ${classification.reason}.`,
      classificationReason: classification.reason,
    });
  }

  const identity = resolveConnectToolOperationIdentity({
    tool: request.descriptor,
    input: request.input,
    explicitIdentity: request.explicitIdentity,
  });

  if (identity.status === "CONFLICT") {
    return freezeResult({
      version: CONNECT_PREFLIGHT_VERSION,
      decision: "BLOCK",
      code: "IDENTITY_CONFLICT",
      consequential: true,
      reason: identity.reason,
      classificationReason: classification.reason,
    });
  }

  if (identity.status === "REQUIRED") {
    return freezeResult({
      version: CONNECT_PREFLIGHT_VERSION,
      decision: "BLOCK",
      code: "IDENTITY_REQUIRED",
      consequential: true,
      reason: identity.reason,
      classificationReason: classification.reason,
    });
  }

  let payload: Readonly<ConnectPayload> | null;
  let payloadSource: ConnectPreflightPayloadSource;

  if (request.payload !== undefined) {
    payload = frozenPayload(request.payload);
    payloadSource = "explicit";

    if (!payload) {
      return freezeResult({
        version: CONNECT_PREFLIGHT_VERSION,
        decision: "BLOCK",
        code: "PAYLOAD_REQUIRED",
        consequential: true,
        reason: "Explicit Connect effect payload is not canonical JSON-safe data.",
        classificationReason: classification.reason,
      });
    }
  } else {
    const resolvedPayload = resolveConnectToolEffectPayload({
      tool: request.descriptor,
      input: request.input,
    });

    if (resolvedPayload.status === "REQUIRED") {
      return freezeResult({
        version: CONNECT_PREFLIGHT_VERSION,
        decision: "BLOCK",
        code: "PAYLOAD_REQUIRED",
        consequential: true,
        reason: resolvedPayload.reason,
        classificationReason: classification.reason,
      });
    }

    payload = resolvedPayload.payload;
    payloadSource = resolvedPayload.source;
  }

  const binding = bindConnectOperation({
    operationId: identity.operationId,
    payload: payload as ConnectPayload,
  });

  return freezeResult({
    version: CONNECT_PREFLIGHT_VERSION,
    decision: "PROTECT",
    code: "TOOL_PROTECT",
    consequential: true,
    reason: "Tool call has deterministic protection routing, logical-operation identity, and effect binding.",
    classificationReason: classification.reason,
    operationId: binding.operationId,
    identitySource: identity.source,
    payload,
    payloadSource,
    payloadFingerprint: binding.payloadFingerprint,
  });
}

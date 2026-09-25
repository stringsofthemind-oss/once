import { createHash } from "node:crypto";
import {
  canonicalizeConnectPayload,
} from "./binding.js";
import type {
  ConnectToolDescriptor,
} from "./tool-classifier.js";

export type ConnectIdentitySource =
  | "explicit"
  | "input:once_operation_id"
  | "input:onceOperationId"
  | "input:operation_id"
  | "input:operationId"
  | "input:idempotency_key"
  | "input:idempotencyKey"
  | "input:intent_id"
  | "input:intentId"
  | "input:intent_key"
  | "input:intentKey"
  | "meta:identity_fields";

export type ConnectIdentityResult =
  | Readonly<{
      status: "FOUND";
      operationId: string;
      source: ConnectIdentitySource;
      reason: string;
    }>
  | Readonly<{
      status: "REQUIRED";
      reason: string;
    }>
  | Readonly<{
      status: "CONFLICT";
      sources: readonly ConnectIdentitySource[];
      reason: string;
    }>;

export interface ResolveConnectIdentityInput {
  tool: Pick<ConnectToolDescriptor, "name" | "_meta">;
  input: unknown;
  explicitIdentity?: string;
}

type IdentityCandidate = {
  source: ConnectIdentitySource;
  value: string;
};

const INPUT_FIELDS: readonly {
  key: string;
  source: ConnectIdentitySource;
}[] = [
  { key: "once_operation_id", source: "input:once_operation_id" },
  { key: "onceOperationId", source: "input:onceOperationId" },
  { key: "operation_id", source: "input:operation_id" },
  { key: "operationId", source: "input:operationId" },
  { key: "idempotency_key", source: "input:idempotency_key" },
  { key: "idempotencyKey", source: "input:idempotencyKey" },
  { key: "intent_id", source: "input:intent_id" },
  { key: "intentId", source: "input:intentId" },
  { key: "intent_key", source: "input:intent_key" },
  { key: "intentKey", source: "input:intentKey" },
];

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const objectValue = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(objectValue);

  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }

  return objectValue;
}

function metadataIdentityFields(
  tool: Pick<ConnectToolDescriptor, "_meta">,
): readonly string[] | null {
  const meta = plainObject(tool._meta);
  if (!meta) {
    return null;
  }

  const once = plainObject(meta.once);
  if (!once || !Array.isArray(once.identityFields)) {
    return null;
  }

  const fields = once.identityFields;

  if (
    fields.length === 0 ||
    fields.some(field =>
      typeof field !== "string" ||
      field.trim().length === 0 ||
      field.includes("."),
    )
  ) {
    return null;
  }

  return Object.freeze(fields.map(field => field.trim()));
}

function metadataIdentityCandidate(
  tool: Pick<ConnectToolDescriptor, "_meta">,
  input: Record<string, unknown>,
): IdentityCandidate | null {
  const fields = metadataIdentityFields(tool);
  if (!fields) {
    return null;
  }

  const identity: Record<string, unknown> = {};

  for (const field of fields) {
    if (!(field in input)) {
      return null;
    }

    const value = input[field];

    if (value === undefined) {
      return null;
    }

    identity[field] = value;
  }

  try {
    return {
      source: "meta:identity_fields",
      value: canonicalizeConnectPayload(identity),
    };
  } catch {
    return null;
  }
}

function buildOperationId(toolName: string, identity: string): string {
  const hash = createHash("sha256");

  hash.update("once-connect-id-v1\u0000", "utf8");

  for (const value of [toolName, identity]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length, 0);
    hash.update(length);
    hash.update(bytes);
  }

  const prefix = toolName
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/g, "")
    .slice(0, 48) || "tool";

  return `${prefix}:${hash.digest("hex").slice(0, 32)}`;
}

/**
 * Resolve stable logical-operation identity for an agent tool call.
 *
 * V1 deliberately refuses to derive identity from the full payload. Payload
 * equality does not prove that two calls represent the same user intent.
 *
 * Trustworthy identity comes from:
 * - an explicit caller-provided stable identity;
 * - conventional operation/idempotency/intent carriers in parsed input;
 * - tool-authored `_meta.once.identityFields` when no stronger carrier exists.
 *
 * Generic request IDs, call IDs, timestamps, and arbitrary `id` fields are not
 * treated as logical-operation identity because they commonly change on retry.
 */
export function resolveConnectToolOperationIdentity(
  request: ResolveConnectIdentityInput,
): ConnectIdentityResult {
  if (
    !request ||
    !request.tool ||
    typeof request.tool.name !== "string" ||
    request.tool.name.trim().length === 0
  ) {
    return Object.freeze({
      status: "REQUIRED",
      reason: "A stable tool name is required before operation identity can be resolved.",
    });
  }

  const input = plainObject(request.input);
  if (!input) {
    return Object.freeze({
      status: "REQUIRED",
      reason: "Parsed plain-object tool input is required before operation identity can be resolved.",
    });
  }

  const candidates: IdentityCandidate[] = [];
  const explicit = cleanString(request.explicitIdentity);

  if (explicit) {
    candidates.push({
      source: "explicit",
      value: explicit,
    });
  }

  for (const field of INPUT_FIELDS) {
    const value = cleanString(input[field.key]);

    if (value) {
      candidates.push({
        source: field.source,
        value,
      });
    }
  }

  if (candidates.length > 0) {
    const values = Array.from(new Set(candidates.map(candidate => candidate.value)));

    if (values.length !== 1) {
      return Object.freeze({
        status: "CONFLICT",
        sources: Object.freeze(candidates.map(candidate => candidate.source)),
        reason: "Stable identity carriers disagree. Once Connect refuses ambiguous logical-operation identity.",
      });
    }

    return Object.freeze({
      status: "FOUND",
      operationId: buildOperationId(request.tool.name.trim(), values[0]),
      source: candidates[0].source,
      reason: "Stable logical-operation identity found and deterministically scoped to this tool.",
    });
  }

  const metadataCandidate = metadataIdentityCandidate(request.tool, input);

  if (metadataCandidate) {
    return Object.freeze({
      status: "FOUND",
      operationId: buildOperationId(
        request.tool.name.trim(),
        metadataCandidate.value,
      ),
      source: metadataCandidate.source,
      reason: "Tool metadata declared the input fields that define stable logical-operation identity.",
    });
  }

  return Object.freeze({
    status: "REQUIRED",
    reason: "No trustworthy stable identity carrier was found. Once Connect refuses to guess from the full payload.",
  });
}

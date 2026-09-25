import {
  canonicalizeConnectPayload,
} from "./binding.js";
import type {
  ConnectToolDescriptor,
} from "./tool-classifier.js";

export type ConnectPayloadSource =
  | "full_input"
  | "meta:effect_fields";

export type ConnectEffectPayloadResult =
  | Readonly<{
      status: "FOUND";
      payload: Readonly<Record<string, unknown>>;
      source: ConnectPayloadSource;
      reason: string;
    }>
  | Readonly<{
      status: "REQUIRED";
      reason: string;
    }>;

export interface ResolveConnectEffectPayloadInput {
  tool: Pick<ConnectToolDescriptor, "name" | "_meta">;
  input: unknown;
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

function configuredEffectFields(
  tool: Pick<ConnectToolDescriptor, "_meta">,
): readonly string[] | null | "INVALID" {
  const meta = plainObject(tool._meta);
  if (!meta) {
    return null;
  }

  const once = plainObject(meta.once);
  if (!once || once.effectFields === undefined) {
    return null;
  }

  if (!Array.isArray(once.effectFields) || once.effectFields.length === 0) {
    return "INVALID";
  }

  const fields = once.effectFields;

  if (
    fields.some(field =>
      typeof field !== "string" ||
      field.trim().length === 0 ||
      field.includes("."),
    )
  ) {
    return "INVALID";
  }

  const normalized = fields.map(field => field.trim());

  if (new Set(normalized).size !== normalized.length) {
    return "INVALID";
  }

  return Object.freeze(normalized);
}

function jsonSafeSnapshot(
  value: Record<string, unknown>,
): Readonly<Record<string, unknown>> | null {
  try {
    const canonical = canonicalizeConnectPayload(value);
    return Object.freeze(JSON.parse(canonical) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Resolve the effect-bearing payload to bind to a protected tool call.
 *
 * Safety policy:
 * - tool-authored `_meta.once.effectFields` may explicitly narrow the bound
 *   payload to complete, top-level effect fields;
 * - otherwise the entire parsed plain-object input is bound.
 *
 * The full-input fallback is deliberately conservative. It may produce a
 * conflict when unrelated retry metadata changes, but it cannot silently omit
 * an input field that changes the external effect. Callers that need a narrower
 * contract can keep using an explicit payload callback or declare effectFields.
 */
export function resolveConnectToolEffectPayload(
  request: ResolveConnectEffectPayloadInput,
): ConnectEffectPayloadResult {
  if (
    !request ||
    !request.tool ||
    typeof request.tool.name !== "string" ||
    request.tool.name.trim().length === 0
  ) {
    return Object.freeze({
      status: "REQUIRED",
      reason: "A stable tool descriptor is required before an effect payload can be resolved.",
    });
  }

  const input = plainObject(request.input);

  if (!input) {
    return Object.freeze({
      status: "REQUIRED",
      reason: "Automatic effect binding requires parsed plain-object tool input. Supply an explicit payload callback for other input shapes.",
    });
  }

  const fields = configuredEffectFields(request.tool);

  if (fields === "INVALID") {
    return Object.freeze({
      status: "REQUIRED",
      reason: "Tool metadata contains an invalid once.effectFields declaration.",
    });
  }

  if (fields) {
    const selected: Record<string, unknown> = {};

    for (const field of fields) {
      if (!(field in input) || input[field] === undefined) {
        return Object.freeze({
          status: "REQUIRED",
          reason: `Declared effect field "${field}" is missing from the tool input.`,
        });
      }

      selected[field] = input[field];
    }

    const payload = jsonSafeSnapshot(selected);

    if (!payload) {
      return Object.freeze({
        status: "REQUIRED",
        reason: "Declared effect fields are not canonical JSON-safe data.",
      });
    }

    return Object.freeze({
      status: "FOUND",
      payload,
      source: "meta:effect_fields",
      reason: "Tool metadata declared the complete top-level fields that define the external effect.",
    });
  }

  const payload = jsonSafeSnapshot(input);

  if (!payload) {
    return Object.freeze({
      status: "REQUIRED",
      reason: "Automatic full-input effect binding requires canonical JSON-safe data. Supply an explicit payload callback to select safe effect-bearing values.",
    });
  }

  return Object.freeze({
    status: "FOUND",
    payload,
    source: "full_input",
    reason: "The entire parsed tool input is conservatively bound as effect-bearing data.",
  });
}

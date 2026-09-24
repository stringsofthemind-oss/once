import { createHash } from "node:crypto";

export class ConnectBindingError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ConnectBindingError";
    this.code = code;
  }
}

function canonicalize(value, path = "$") {
  if (value === null) {
    return "null";
  }

  const type = typeof value;

  if (type === "string") {
    return JSON.stringify(value);
  }

  if (type === "boolean") {
    return value ? "true" : "false";
  }

  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new ConnectBindingError(
        `Unsupported non-finite number at ${path}.`,
        "UNSUPPORTED_PAYLOAD_VALUE",
      );
    }

    if (Object.is(value, -0)) {
      return "0";
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return "[" +
      value
        .map((item, index) =>
          canonicalize(item, `${path}[${index}]`),
        )
        .join(",") +
      "]";
  }

  if (type === "object") {
    const prototype = Object.getPrototypeOf(value);

    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new ConnectBindingError(
        `Unsupported object type at ${path}.`,
        "UNSUPPORTED_PAYLOAD_VALUE",
      );
    }

    const keys = Object.keys(value).sort();

    return "{" +
      keys
        .map((key) =>
          `${JSON.stringify(key)}:${canonicalize(
            value[key],
            `${path}.${key}`,
          )}`,
        )
        .join(",") +
      "}";
  }

  throw new ConnectBindingError(
    `Unsupported payload value at ${path}.`,
    "UNSUPPORTED_PAYLOAD_VALUE",
  );
}

export function canonicalizeConnectPayload(payload) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new ConnectBindingError(
      "Once Connect payload must be a plain object.",
      "INVALID_PAYLOAD",
    );
  }

  return canonicalize(payload);
}

export function fingerprintConnectPayload(payload) {
  const canonical =
    canonicalizeConnectPayload(payload);

  const digest = createHash("sha256")
    .update("once-connect-payload-v1\0", "utf8")
    .update(canonical, "utf8")
    .digest("hex");

  return `once-connect-payload-v1:${digest}`;
}

export function bindConnectOperation({
  operationId,
  payload,
}) {
  if (
    typeof operationId !== "string" ||
    operationId.trim() === ""
  ) {
    throw new ConnectBindingError(
      "Once Connect requires a stable operationId.",
      "INVALID_OPERATION_ID",
    );
  }

  return Object.freeze({
    operationId,
    payloadFingerprint:
      fingerprintConnectPayload(payload),
  });
}

export function assertConnectBindingMatch(
  previousBinding,
  nextBinding,
) {
  if (
    previousBinding.operationId !==
    nextBinding.operationId
  ) {
    throw new ConnectBindingError(
      "Operation identities do not match.",
      "OPERATION_ID_MISMATCH",
    );
  }

  if (
    previousBinding.payloadFingerprint !==
    nextBinding.payloadFingerprint
  ) {
    throw new ConnectBindingError(
      "The same operationId was reused with a different consequential payload.",
      "PAYLOAD_DRIFT",
    );
  }

  return true;
}

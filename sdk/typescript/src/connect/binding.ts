import { createHash } from "node:crypto";

export type ConnectPayload =
  Record<string, unknown>;

export interface ConnectBinding {
  operationId: string;
  payloadFingerprint: string;
}

export class ConnectBindingError extends Error {
  readonly code: string;

  constructor(
    message: string,
    code: string,
  ) {
    super(message);
    this.name = "ConnectBindingError";
    this.code = code;
  }
}

function canonicalize(
  value: unknown,
  path = "$",
): string {
  if (value === null) {
    return "null";
  }

  const type =
    typeof value;

  if (type === "string") {
    return JSON.stringify(value);
  }

  if (type === "boolean") {
    return value ? "true" : "false";
  }

  if (type === "number") {
    const numberValue =
      value as number;

    if (!Number.isFinite(numberValue)) {
      throw new ConnectBindingError(
        `Unsupported non-finite number at ${path}.`,
        "UNSUPPORTED_PAYLOAD_VALUE",
      );
    }

    if (Object.is(numberValue, -0)) {
      return "0";
    }

    return JSON.stringify(numberValue);
  }

  if (Array.isArray(value)) {
    return "[" +
      value
        .map((item, index) =>
          canonicalize(
            item,
            `${path}[${index}]`,
          ),
        )
        .join(",") +
      "]";
  }

  if (type === "object") {
    const objectValue =
      value as Record<string, unknown>;

    const prototype =
      Object.getPrototypeOf(objectValue);

    if (
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new ConnectBindingError(
        `Unsupported object type at ${path}.`,
        "UNSUPPORTED_PAYLOAD_VALUE",
      );
    }

    const keys =
      Object.keys(objectValue).sort();

    return "{" +
      keys
        .map((key) =>
          `${JSON.stringify(key)}:${canonicalize(
            objectValue[key],
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

export function canonicalizeConnectPayload(
  payload: ConnectPayload,
): string {
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

export function fingerprintConnectPayload(
  payload: ConnectPayload,
): string {
  const canonical =
    canonicalizeConnectPayload(payload);

  const digest =
    createHash("sha256")
      .update(
        "once-connect-payload-v1\0",
        "utf8",
      )
      .update(canonical, "utf8")
      .digest("hex");

  return `once-connect-payload-v1:${digest}`;
}

export function bindConnectOperation({
  operationId,
  payload,
}: {
  operationId: string;
  payload: ConnectPayload;
}): Readonly<ConnectBinding> {
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
  previousBinding: ConnectBinding,
  nextBinding: ConnectBinding,
): true {
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

import {
  createHash
} from "node:crypto";

export type RuntimeIdentitySource =
  | "explicit"
  | "header:idempotency-key"
  | "header:x-idempotency-key"
  | "body:once_operation_id"
  | "body:onceOperationId"
  | "body:operation_id"
  | "body:operationId"
  | "body:idempotency_key"
  | "body:idempotencyKey";

export type RuntimeIdentityInput = {
  method: string;
  url: string;
  operationId?: string;
  headers?: Record<
    string,
    string | string[] | undefined
  >;
  body?: unknown;
};

export type RuntimeIdentityResult =
  | {
      status: "FOUND";
      operationId: string;
      source: RuntimeIdentitySource;
      reason: string;
    }
  | {
      status: "REQUIRED";
      reason: string;
    }
  | {
      status: "CONFLICT";
      sources: RuntimeIdentitySource[];
      reason: string;
    };

type Candidate = {
  source: RuntimeIdentitySource;
  value: string;
};

const BODY_FIELDS: Array<{
  key: string;
  source: RuntimeIdentitySource;
}> = [
  {
    key: "once_operation_id",
    source: "body:once_operation_id"
  },
  {
    key: "onceOperationId",
    source: "body:onceOperationId"
  },
  {
    key: "operation_id",
    source: "body:operation_id"
  },
  {
    key: "operationId",
    source: "body:operationId"
  },
  {
    key: "idempotency_key",
    source: "body:idempotency_key"
  },
  {
    key: "idempotencyKey",
    source: "body:idempotencyKey"
  }
];

function clean(
  value: unknown
): string | null {

  if (typeof value !== "string") {
    return null;
  }

  const result = value.trim();

  return result.length > 0
    ? result
    : null;
}

function normalizeMethod(
  value: string
): string {

  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeUrl(
  value: string
): string | null {

  try {

    const url =
      new URL(value);

    if (
      url.protocol !== "https:" &&
      url.protocol !== "http:"
    ) {
      return null;
    }

    url.hash = "";

    const params =
      Array.from(
        url.searchParams.entries()
      ).sort(
        ([ak, av], [bk, bv]) =>
          ak.localeCompare(bk) ||
          av.localeCompare(bv)
      );

    url.search = "";

    for (const [key, item] of params) {
      url.searchParams.append(
        key,
        item
      );
    }

    return url.toString();

  } catch {

    return null;
  }
}

function headerValue(
  headers:
    RuntimeIdentityInput["headers"],
  wanted: string
): string | null {

  if (!headers) {
    return null;
  }

  for (
    const [key, value]
    of Object.entries(headers)
  ) {

    if (
      key.toLowerCase() !==
      wanted.toLowerCase()
    ) {
      continue;
    }

    if (Array.isArray(value)) {

      const valid =
        value
          .map(clean)
          .filter(
            (
              item
            ): item is string =>
              item !== null
          );

      return valid.length === 1
        ? valid[0]
        : null;
    }

    return clean(value);
  }

  return null;
}

function bodyObject(
  body: unknown
): Record<string, unknown> | null {

  if (
    body === null ||
    body === undefined
  ) {
    return null;
  }

  if (typeof body === "string") {

    try {

      const parsed =
        JSON.parse(body);

      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<
          string,
          unknown
        >;
      }

      return null;

    } catch {

      return null;
    }
  }

  if (
    typeof body === "object" &&
    !Array.isArray(body)
  ) {
    return body as Record<
      string,
      unknown
    >;
  }

  return null;
}

function candidates(
  input: RuntimeIdentityInput
): Candidate[] {

  const result: Candidate[] = [];

  const explicit =
    clean(input.operationId);

  if (explicit) {
    result.push({
      source: "explicit",
      value: explicit
    });
  }

  const normalHeader =
    headerValue(
      input.headers,
      "idempotency-key"
    );

  if (normalHeader) {
    result.push({
      source:
        "header:idempotency-key",
      value:
        normalHeader
    });
  }

  const alternateHeader =
    headerValue(
      input.headers,
      "x-idempotency-key"
    );

  if (alternateHeader) {
    result.push({
      source:
        "header:x-idempotency-key",
      value:
        alternateHeader
    });
  }

  const body =
    bodyObject(
      input.body
    );

  if (body) {

    for (const field of BODY_FIELDS) {

      const value =
        clean(
          body[field.key]
        );

      if (value) {
        result.push({
          source:
            field.source,
          value
        });
      }
    }
  }

  return result;
}

function buildOperationId(
  method: string,
  url: string,
  identity: string
): string {

  const hash =
    createHash("sha256");

  hash.update(
    "once-runtime-http-id-v1\u0000",
    "utf8"
  );

  for (
    const value
    of [method, url, identity]
  ) {

    const bytes =
      Buffer.from(
        value,
        "utf8"
      );

    const length =
      Buffer.allocUnsafe(4);

    length.writeUInt32BE(
      bytes.length,
      0
    );

    hash.update(length);
    hash.update(bytes);
  }

  return (
    "http:" +
    hash
      .digest("hex")
      .slice(0, 32)
  );
}

export function resolveHttpOperationIdentity(
  input: RuntimeIdentityInput
): RuntimeIdentityResult {

  const method =
    normalizeMethod(
      input.method
    );

  const url =
    normalizeUrl(
      input.url
    );

  if (!url) {
    return {
      status: "REQUIRED",
      reason:
        "A valid HTTP(S) destination is required."
    };
  }

  const found =
    candidates(input);

  if (found.length === 0) {
    return {
      status: "REQUIRED",
      reason:
        "No trustworthy stable identity carrier was found. Runtime refuses to guess."
    };
  }

  const values =
    Array.from(
      new Set(
        found.map(
          item => item.value
        )
      )
    );

  if (values.length !== 1) {
    return {
      status: "CONFLICT",
      sources:
        found.map(
          item => item.source
        ),
      reason:
        "Stable identity carriers disagree. Runtime refuses ambiguous identity."
    };
  }

  return {
    status: "FOUND",
    operationId:
      buildOperationId(
        method,
        url,
        values[0]
      ),
    source:
      found[0].source,
    reason:
      "Stable identity found and deterministically bound to this HTTP operation."
  };
}
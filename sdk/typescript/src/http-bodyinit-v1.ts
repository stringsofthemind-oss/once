import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const HTTP_BODYINIT_CONTRACT_ID =
  "http_bodyinit_v1" as const;

export type HttpBodyInitBytesV1 = {
  contract:
    typeof HTTP_BODYINIT_CONTRACT_ID;
  kind: "bytes";
  bytes_base64: string;
  byte_length: number;
  content_type: string | null;
};

export type HttpBodyInitNoneV1 = {
  contract:
    typeof HTTP_BODYINIT_CONTRACT_ID;
  kind: "none";
};

export type HttpBodyInitFormFieldV1 = {
  name: string;
  value: {
    kind: "text";
    text: string;
  } | {
    kind: "file";
    filename: string;
    media_type: string;
    bytes_base64: string;
    byte_length: number;
  };
};

export type HttpBodyInitFormDataV1 = {
  contract:
    typeof HTTP_BODYINIT_CONTRACT_ID;
  kind: "form_data";
  entries: HttpBodyInitFormFieldV1[];
};

export type NormalizedHttpBodyInitV1 =
  | HttpBodyInitNoneV1
  | HttpBodyInitBytesV1
  | HttpBodyInitFormDataV1;

export class HttpBodyInitNormalizationError
  extends Error {

  readonly code: string;

  constructor(
    code: string,
    message: string,
    options: {
      cause?: unknown;
    } = {}
  ) {
    super(message, {
      cause:
        options.cause
    });

    this.name =
      "HttpBodyInitNormalizationError";

    this.code =
      code;
  }
}

function canonicalJson(
  value: unknown
): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }

  if (
    typeof value === "number"
  ) {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "BodyInit canonical form contains a non-finite number."
      );
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return (
      "[" +
      value
        .map(canonicalJson)
        .join(",") +
      "]"
    );
  }

  if (
    value === null ||
    typeof value !== "object"
  ) {
    throw new TypeError(
      "BodyInit canonical form contains an unsupported value."
    );
  }

  const record =
    value as Record<string, unknown>;

  const keys =
    Object.keys(record)
      .sort();

  return (
    "{" +
    keys
      .map(
        key =>
          JSON.stringify(key) +
          ":" +
          canonicalJson(
            record[key]
          )
      )
      .join(",") +
    "}"
  );
}

function base64(
  bytes: ArrayBuffer
): string {
  return Buffer
    .from(bytes)
    .toString("base64");
}

function isReadableStream(
  value: unknown
): boolean {
  return (
    typeof ReadableStream !==
      "undefined" &&
    value instanceof
      ReadableStream
  );
}

async function normalizeFormData(
  formData: FormData
): Promise<HttpBodyInitFormDataV1> {
  const entries:
    HttpBodyInitFormFieldV1[] = [];

  for (
    const [name, value]
    of formData.entries()
  ) {
    if (
      typeof value ===
      "string"
    ) {
      entries.push({
        name,
        value: {
          kind: "text",
          text: value
        }
      });

      continue;
    }

    if (
      typeof Blob ===
        "undefined" ||
      !(value instanceof Blob)
    ) {
      throw new HttpBodyInitNormalizationError(
        "unsupported_form_data_entry",
        "FormData contains an entry that is neither text nor a Blob/File."
      );
    }

    const filename =
      typeof (
        value as Blob & {
          name?: unknown;
        }
      ).name === "string"
        ? String(
            (
              value as Blob & {
                name: string;
              }
            ).name
          )
        : "blob";

    const bytes =
      await value.arrayBuffer();

    entries.push({
      name,
      value: {
        kind: "file",
        filename,
        media_type:
          value.type,
        bytes_base64:
          base64(bytes),
        byte_length:
          bytes.byteLength
      }
    });
  }

  return {
    contract:
      HTTP_BODYINIT_CONTRACT_ID,
    kind: "form_data",
    entries
  };
}

/**
 * Normalize the value supplied to `fetch(..., { body })`
 * without guessing that it is JSON or text.
 *
 * v1 intentionally has two execution representations:
 *
 * - ordinary successful BodyInit values are normalized through
 *   the platform Request implementation to exact wire bytes plus
 *   the automatically selected Content-Type (if any);
 * - FormData is represented as ordered semantic entries so the
 *   random multipart boundary cannot enter retry/effect identity.
 *
 * ReadableStream request bodies are outside this contract. The
 * fixed automatic source shape has no duplex/stream semantics to
 * prove, so the contract fails closed rather than inventing them.
 */
export async function normalizeHttpBodyInitV1(
  body: unknown
): Promise<NormalizedHttpBodyInitV1> {
  if (
    body === undefined ||
    body === null
  ) {
    return {
      contract:
        HTTP_BODYINIT_CONTRACT_ID,
      kind: "none"
    };
  }

  if (isReadableStream(body)) {
    throw new HttpBodyInitNormalizationError(
      "unsupported_stream_body",
      "ReadableStream request bodies are outside the proven BodyInit v1 contract."
    );
  }

  if (
    typeof FormData !==
      "undefined" &&
    body instanceof FormData
  ) {
    return normalizeFormData(
      body
    );
  }

  let request: Request;

  try {
    request =
      new Request(
        "https://once.invalid/bodyinit-v1",
        {
          method: "POST",
          body:
            body as BodyInit
        }
      );
  }
  catch (error) {
    throw new HttpBodyInitNormalizationError(
      "invalid_bodyinit",
      "The value cannot be represented by the platform Request BodyInit contract.",
      {
        cause: error
      }
    );
  }

  let bytes: ArrayBuffer;

  try {
    bytes =
      await request
        .arrayBuffer();
  }
  catch (error) {
    throw new HttpBodyInitNormalizationError(
      "body_read_failed",
      "The request body could not be read into a replayable byte representation.",
      {
        cause: error
      }
    );
  }

  return {
    contract:
      HTTP_BODYINIT_CONTRACT_ID,
    kind: "bytes",
    bytes_base64:
      base64(bytes),
    byte_length:
      bytes.byteLength,
    content_type:
      request.headers.get(
        "content-type"
      )
  };
}

export function fingerprintHttpBodyInitV1(
  value: NormalizedHttpBodyInitV1
): string {
  return createHash("sha256")
    .update(
      canonicalJson(value),
      "utf8"
    )
    .digest("hex");
}

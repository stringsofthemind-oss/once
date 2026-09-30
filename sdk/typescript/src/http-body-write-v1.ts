import Once, {
  OnceError,
  type ExecuteResponse,
  type OnceOptions,
  type OnceProvider
} from "./index.js";

import {
  normalizeHttpBodyInitV1,
  type NormalizedHttpBodyInitV1
} from "./http-bodyinit-v1.js";

export const HTTP_BODY_WRITE_ACTION_TYPE =
  "http_body_write_v1" as const;

export type HttpBodyWriteMethod =
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export type HttpBodyWriteActionV1 = {
  type:
    typeof HTTP_BODY_WRITE_ACTION_TYPE;
  method:
    HttpBodyWriteMethod;
  url: string;
  body_v1:
    NormalizedHttpBodyInitV1;
};

export type ExecuteHttpBodyWriteV1Input = {
  operationId: string;
  provider:
    OnceProvider;
  method:
    HttpBodyWriteMethod;
  url: string;
  body: unknown;
};

export type ExecuteHttpBodyWriteV1Options =
  OnceOptions;

function canonicalHttpsUrl(
  value: string
): string {
  const raw =
    value.trim();

  let parsed: URL;

  try {
    parsed =
      new URL(raw);
  }
  catch (error) {
    throw new OnceError(
      "HTTP BodyInit execution requires a valid HTTPS target URL.",
      {
        code:
          "invalid_http_body_target_url",
        cause: error
      }
    );
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new OnceError(
      "HTTP BodyInit execution requires an HTTPS target without credentials or a fragment.",
      {
        code:
          "invalid_http_body_target_url"
      }
    );
  }

  parsed.searchParams.sort();

  const canonical =
    parsed.toString();

  if (canonical !== raw) {
    throw new OnceError(
      "HTTP BodyInit execution requires the exact canonical HTTPS target URL.",
      {
        code:
          "noncanonical_http_body_target_url"
      }
    );
  }

  return canonical;
}

function exactMethod(
  value: string
): HttpBodyWriteMethod {
  if (
    value === "POST" ||
    value === "PUT" ||
    value === "PATCH" ||
    value === "DELETE"
  ) {
    return value;
  }

  throw new OnceError(
    "HTTP BodyInit execution supports exact POST, PUT, PATCH, or DELETE methods only.",
    {
      code:
        "invalid_http_body_method"
    }
  );
}

/**
 * Build the future `http_body_write_v1` action from the same
 * runtime BodyInit value that native fetch would receive.
 *
 * This helper is intentionally not exported from the public
 * package surface yet. The SDK-side action contract can be
 * regression-tested independently, but automatic protection must
 * remain disabled until Once Cloud and the registered provider
 * contract both prove `bodyinit_v1` execution end-to-end.
 */
export async function executeHttpBodyWriteV1(
  input:
    ExecuteHttpBodyWriteV1Input,
  options:
    ExecuteHttpBodyWriteV1Options = {}
): Promise<ExecuteResponse> {
  const operationId =
    String(
      input.operationId ||
      ""
    ).trim();

  if (!operationId) {
    throw new OnceError(
      "operationId is required.",
      {
        code:
          "invalid_operation_id"
      }
    );
  }

  const provider =
    String(
      input.provider ||
      ""
    ).trim();

  if (!provider) {
    throw new OnceError(
      "provider is required.",
      {
        code:
          "invalid_provider"
      }
    );
  }

  const method =
    exactMethod(
      String(input.method)
    );

  const url =
    canonicalHttpsUrl(
      String(input.url)
    );

  /*
   * Normalize before constructing the network client. Unsupported
   * request bodies fail locally before any Once request is sent.
   */
  const normalizedBody =
    await normalizeHttpBodyInitV1(
      input.body
    );

  const action:
    HttpBodyWriteActionV1 = {
      type:
        HTTP_BODY_WRITE_ACTION_TYPE,
      method,
      url,
      body_v1:
        normalizedBody
    };

  const once =
    new Once(options);

  return once.execute({
    operationId,
    provider,
    action
  });
}

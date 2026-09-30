import Once, {
  OnceError,
  type ExecuteInput,
  type OnceOptions
} from "./index.js";

export type ExecuteHttpWriteJsonOptions =
  OnceOptions;

function parseReplayBody(
  value: unknown
): string {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new OnceError(
      "Once confirmed the operation but did not return a replayable HTTP response.",
      {
        code:
          "runtime_http_response_missing",
        body:
          value
      }
    );
  }

  const candidate =
    value as Record<string, unknown>;

  const status =
    Number(candidate.status);

  if (
    !Number.isInteger(status) ||
    status < 200 ||
    status > 599
  ) {
    throw new OnceError(
      "Once returned an HTTP replay with an unsupported status.",
      {
        code:
          "runtime_http_response_invalid_status",
        body:
          value
      }
    );
  }

  if (
    typeof candidate.body_text !==
      "string"
  ) {
    throw new OnceError(
      "Once returned an HTTP replay without a valid text body.",
      {
        code:
          "runtime_http_response_invalid_body",
        body:
          value
      }
    );
  }

  if (
    candidate.headers === null ||
    typeof candidate.headers !==
      "object" ||
    Array.isArray(candidate.headers)
  ) {
    throw new OnceError(
      "Once returned an HTTP replay without valid headers.",
      {
        code:
          "runtime_http_response_invalid_headers",
        body:
          value
      }
    );
  }

  for (
    const headerValue
    of Object.values(
      candidate.headers
    )
  ) {
    if (
      typeof headerValue !==
        "string"
    ) {
      throw new OnceError(
        "Once returned a non-string HTTP replay header.",
        {
          code:
            "runtime_http_response_invalid_headers",
          body:
            value
        }
      );
    }
  }

  const nullBody =
    status === 204 ||
    status === 205 ||
    status === 304;

  if (
    nullBody &&
    candidate.body_text.length > 0
  ) {
    throw new OnceError(
      "Once returned a body for an HTTP status that cannot carry one.",
      {
        code:
          "runtime_http_response_invalid_body",
        body:
          value
      }
    );
  }

  return candidate.body_text;
}

/**
 * Execute one already-qualified HTTP write through Once
 * and reproduce only the observable semantics of an
 * immediate native `Response.json()` consumption.
 *
 * This helper intentionally does NOT claim to reproduce a
 * complete native Response object. Callers that retain,
 * return, inspect, clone, stream, or otherwise expose the
 * Response remain outside this contract.
 */
export async function executeHttpWriteJsonResponse(
  input: ExecuteInput,
  options: ExecuteHttpWriteJsonOptions = {}
): Promise<unknown> {
  if (
    input.action?.type !==
      "http_write_v1"
  ) {
    throw new OnceError(
      "HTTP JSON replay helper requires an http_write_v1 action.",
      {
        code:
          "invalid_http_response_action",
        body:
          input.action
      }
    );
  }

  const once =
    new Once(options);

  const result =
    await once.execute(input);

  const bodyText =
    parseReplayBody(
      result.http_response
    );

  /*
   * Native Response.json() rejects on an empty or invalid
   * JSON body. JSON.parse() inside this async function has
   * the same promise-rejection shape for that observation.
   */
  return JSON.parse(bodyText);
}

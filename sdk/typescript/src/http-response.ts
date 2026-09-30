import Once, {
  OnceError,
  type ExecuteInput,
  type OnceOptions
} from "./index.js";

import {
  HttpResponseReplayV2Error,
  reconstructHttpResponseReplayV2
} from "./http-response-replay-v2.js";

export type ExecuteHttpWriteResponseOptions =
  OnceOptions;

function replayV2FromHttpEnvelope(
  value: unknown
): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new OnceError(
      "Once confirmed the operation but did not return a replayable native HTTP response.",
      {
        code:
          "runtime_http_response_v2_missing",
        body:
          value
      }
    );
  }

  const candidate =
    value as Record<string, unknown>;

  if (
    candidate.replay_v2 ===
    undefined
  ) {
    throw new OnceError(
      "Once confirmed the operation, but byte-exact native Response replay evidence is unavailable.",
      {
        code:
          "runtime_http_response_v2_missing",
        body:
          value
      }
    );
  }

  return candidate.replay_v2;
}

/**
 * Execute one already-qualified HTTP write through Once and reconstruct the
 * provider's exact supported native Fetch Response from durable replay-v2
 * evidence.
 *
 * Legacy text-only replay is never upgraded or guessed. If the runtime does
 * not return a validated replay-v2 receipt, this helper fails closed.
 */
export async function executeHttpWriteResponse(
  input: ExecuteInput,
  options: ExecuteHttpWriteResponseOptions = {}
): Promise<Response> {
  if (
    input.action?.type !==
      "http_write_v1"
  ) {
    throw new OnceError(
      "Native HTTP Response replay helper requires an http_write_v1 action.",
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

  const replayV2 =
    replayV2FromHttpEnvelope(
      result.http_response
    );

  try {
    return reconstructHttpResponseReplayV2(
      replayV2
    );
  } catch (error) {
    if (
      error instanceof
      HttpResponseReplayV2Error
    ) {
      throw new OnceError(
        "Once returned invalid native HTTP Response replay evidence.",
        {
          code:
            "runtime_http_response_v2_invalid",
          body:
            replayV2,
          cause:
            error
        }
      );
    }

    throw error;
  }
}

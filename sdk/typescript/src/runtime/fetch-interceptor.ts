import {
  prepareHttpExecution,
  type OnceRuntimePipelineResult
} from "./pipeline.js";

export class OnceRuntimeBlockedError
  extends Error {

  readonly code: string;
  readonly decision:
    OnceRuntimePipelineResult;

  constructor(
    decision:
      OnceRuntimePipelineResult
  ) {

    super(
      `Once blocked outbound HTTP execution: ${decision.code}. ${decision.reason}`
    );

    this.name =
      "OnceRuntimeBlockedError";

    this.code =
      decision.code;

    this.decision =
      decision;
  }
}

export type OnceProtectedFetchContext = {
  request: Request;

  decision:
    OnceRuntimePipelineResult;

  provider:
    string | undefined;

  /**
   * Native fetch captured before interception.
   *
   * Protected handlers MUST use this for internal
   * Once/provider network operations so they do
   * not recursively re-enter the interceptor.
   */
  originalFetch:
    typeof fetch;
};

export type OnceProtectedFetchHandler =
  (
    context:
      OnceProtectedFetchContext
  ) => Promise<Response>;

export type OnceFetchInterceptorOptions = {
  /**
   * Runtime v0.1 may use one configured provider
   * for every supported outbound write.
   */
  provider?:
    string;

  /**
   * Optional provider resolver for projects with
   * multiple provider destinations.
   */
  resolveProvider?:
    (
      request: Request
    ) =>
      string |
      undefined |
      Promise<
        string |
        undefined
      >;

  /**
   * Optional application-specific identity hook.
   *
   * The returned value is treated as an explicit
   * stable operation identity by the Runtime.
   */
  resolveOperationId?:
    (
      request: Request
    ) =>
      string |
      undefined |
      Promise<
        string |
        undefined
      >;

  /**
   * Called only when Runtime returns PROTECT.
   *
   * It must preserve fetch Response semantics.
   */
  protect:
    OnceProtectedFetchHandler;

  /**
   * Primarily for tests. Normally Runtime captures
   * the native global fetch implementation.
   */
  fetchImpl?:
    typeof fetch;
};

type FetchInput =
  Parameters<
    typeof fetch
  >[0];

type FetchInit =
  Parameters<
    typeof fetch
  >[1];

function headersToObject(
  headers: Headers
): Record<
  string,
  string
> {

  const result:
    Record<
      string,
      string
    > = {};

  headers.forEach(
    (
      value,
      key
    ) => {

      result[key] =
        value;
    }
  );

  return result;
}

async function inspectBody(
  request: Request
): Promise<unknown> {

  const method =
    request.method
      .trim()
      .toUpperCase();

  if (
    method === "GET" ||
    method === "HEAD" ||
    method === "OPTIONS"
  ) {
    return undefined;
  }

  /*
   * Identity v0.1 currently recognizes JSON-style
   * body identity fields.
   *
   * Clone first so inspection never consumes the
   * actual request body.
   */
  let clone:
    Request;

  try {

    clone =
      request.clone();

  } catch {

    return undefined;
  }

  const contentType =
    clone.headers
      .get(
        "content-type"
      )
      ?.toLowerCase() ??
    "";

  if (
    !contentType.includes(
      "application/json"
    )
  ) {
    return undefined;
  }

  try {

    const text =
      await clone.text();

    return (
      text.length > 0
        ? text
        : undefined
    );

  } catch {

    return undefined;
  }
}

/**
 * Create a fetch-compatible Once interception
 * function without mutating global state.
 */
export function createOnceFetchInterceptor(
  options:
    OnceFetchInterceptorOptions
): typeof fetch {

  const originalFetch =
    options.fetchImpl ??
    globalThis.fetch;

  if (
    typeof originalFetch !==
    "function"
  ) {
    throw new Error(
      "Once Runtime requires a native fetch implementation."
    );
  }

  const intercepted =
    async (
      input:
        FetchInput,

      init?:
        FetchInit
    ): Promise<Response> => {

      /*
       * Constructing a Request gives us one
       * normalized view of URL, method, headers
       * and body while preserving native fetch
       * semantics for the final call.
       */
      const request =
        new Request(
          input,
          init
        );

      const provider =
        options.resolveProvider
          ? await options.resolveProvider(
              request
            )
          : options.provider;

      const explicitOperationId =
        options.resolveOperationId
          ? await options.resolveOperationId(
              request
            )
          : undefined;

      const body =
        await inspectBody(
          request
        );

      const decision =
        prepareHttpExecution({
          method:
            request.method,

          url:
            request.url,

          provider,

          operationId:
            explicitOperationId,

          headers:
            headersToObject(
              request.headers
            ),

          body
        });

      if (
        decision.decision ===
        "PASS"
      ) {

        return await originalFetch(
          request
        );
      }

      if (
        decision.decision ===
        "BLOCK"
      ) {

        throw new OnceRuntimeBlockedError(
          decision
        );
      }

      return await options.protect({
        request,
        decision,
        provider,
        originalFetch
      });
    };

  return intercepted as
    typeof fetch;
}

export type OnceFetchInstallation = {
  restore:
    () => void;

  fetch:
    typeof fetch;
};

/**
 * Install Once at the process-wide fetch boundary.
 *
 * Installation is explicit and reversible.
 */
export function installOnceFetchInterceptor(
  options:
    OnceFetchInterceptorOptions
): OnceFetchInstallation {

  const previous =
    globalThis.fetch;

  const intercepted =
    createOnceFetchInterceptor({
      ...options,
      fetchImpl:
        options.fetchImpl ??
        previous
    });

  globalThis.fetch =
    intercepted;

  let restored =
    false;

  return {
    fetch:
      intercepted,

    restore:
      () => {

        if (restored) {
          return;
        }

        /*
         * Restore only if our interceptor still
         * owns global fetch. Do not overwrite a
         * later runtime/framework replacement.
         */
        if (
          globalThis.fetch ===
          intercepted
        ) {
          globalThis.fetch =
            previous;
        }

        restored =
          true;
      }
  };
}
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  createOnceFetchInterceptor,
  type OnceFetchInstallation,
  type OnceFetchInterceptorOptions,
  type OnceProtectedFetchHandler
} from "./runtime/fetch-interceptor.js";

const DEFAULT_BASE_URL =
  "https://once-q18-cloud.pennywatch.workers.dev";

export type OnceProvider =
  | "blind_test"
  | "http_v1"
  | "stripe_v1"
  | (string & {});

export interface OnceOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  networkRetries?: number;
  fetchImpl?: typeof fetch;
}

export interface ExecuteInput {
  operationId: string;
  provider: OnceProvider;
  action: Record<string, unknown>;
}

export interface ExecuteResponse {
  operation_id: string;
  result: string;
  state: string;
  ledger_state?: string;
  attempts?: number;
  side_effects?: number;
  provider_executed?: boolean;
  provider_executed_at?: string | null;
  [key: string]: unknown;
}

export interface OnceRuntimeHttpReplay {
  status: number;
  body_text: string;
  headers: Record<string, string>;
  recorded_at?: string;
}

export type OnceRuntimeFetchOptions =
  Omit<
    OnceFetchInterceptorOptions,
    "protect" | "fetchImpl"
  > &
  OnceOptions;

export interface TruthResponse {
  operation_id: string;
  attempts?: number;
  ledger_state: string;
  state?: string;
  side_effects?: number;
  provider_executed?: boolean;
  provider_executed_at?: string | null;
  first_attempt_at?: string | null;
  last_attempt_at?: string | null;
  [key: string]: unknown;
}

export class OnceError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly body?: unknown;
  readonly retryAfter?: number;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      body?: unknown;
      retryAfter?: number;
      cause?: unknown;
    } = {}
  ) {
    super(message, {
      cause: options.cause
    });

    this.name = "OnceError";
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
    this.retryAfter = options.retryAfter;
  }
}

export class OnceRuntimeHttpShapeError
  extends OnceError {

  constructor(
    message: string,
    code =
      "unsupported_runtime_http_shape"
  ) {
    super(
      message,
      {
        code
      }
    );

    this.name =
      "OnceRuntimeHttpShapeError";
  }
}

export class OnceTimeoutError extends OnceError {
  constructor(message = "Once request timed out", cause?: unknown) {
    super(message, {
      code: "timeout",
      cause
    });

    this.name = "OnceTimeoutError";
  }
}

export class OnceNetworkError extends OnceError {
  constructor(message = "Could not reach Once", cause?: unknown) {
    super(message, {
      code: "network_error",
      cause
    });

    this.name = "OnceNetworkError";
  }
}

export class Once {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly networkRetries: number;
  readonly fetchImpl: typeof fetch;

  constructor(options: OnceOptions = {}) {
    const apiKey =
      options.apiKey ??
      process.env.ONCE_API_KEY;

    if (!apiKey) {
      throw new OnceError(
        "Missing Once API key. Set ONCE_API_KEY or pass { apiKey }.",
        {
          code: "missing_api_key"
        }
      );
    }

    this.apiKey = apiKey;

    this.baseUrl = (
      options.baseUrl ??
      process.env.ONCE_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/+$/, "");

    this.timeoutMs =
      options.timeoutMs ?? 10_000;

    this.networkRetries =
      options.networkRetries ?? 2;

    this.fetchImpl =
      options.fetchImpl ??
      globalThis.fetch;
  }

  /**
   * Generate a deterministic Once operation ID.
   *
   * Same inputs => same ID.
   *
   * Example:
   * Once.id("refund", "order_123")
   */
  static id(...parts: Array<string | number>): string {
    if (parts.length === 0) {
      throw new OnceError(
        "Once.id() requires at least one value.",
        {
          code: "invalid_operation_id"
        }
      );
    }

    const values = parts.map(
      part => {

        if (typeof part === "string") {
          return part;
        }

        if (
          typeof part === "number" &&
          Number.isSafeInteger(part)
        ) {
          return String(part);
        }

        throw new OnceError(
          "Once.id() parts must be strings or safe integers.",
          {
            code: "invalid_operation_id"
          }
        );
      }
    );

    /*
     * Once operation-ID semantic encoding v1.
     *
     * Hash input:
     *   "once-id-v1\\0"
     *   uint32be(part count)
     *   repeated:
     *     uint32be(UTF-8 byte length)
     *     UTF-8 bytes
     *
     * Length-prefixing prevents different part
     * boundaries from producing identical hash input.
     */
    const hashState =
      createHash("sha256");

    hashState.update(
      "once-id-v1\u0000",
      "utf8"
    );

    const partCount =
      Buffer.allocUnsafe(4);

    partCount.writeUInt32BE(
      values.length,
      0
    );

    hashState.update(
      partCount
    );

    for (
      const value
      of values
    ) {

      const bytes =
        Buffer.from(
          value,
          "utf8"
        );

      if (
        bytes.length >
        0xffffffff
      ) {
        throw new OnceError(
          "Once.id() part is too large.",
          {
            code:
              "invalid_operation_id"
          }
        );
      }

      const length =
        Buffer.allocUnsafe(4);

      length.writeUInt32BE(
        bytes.length,
        0
      );

      hashState.update(
        length
      );

      hashState.update(
        bytes
      );
    }

    const hash =
      hashState
        .digest("hex")
        .slice(0, 32);

    const prefix = values[0]
      .replace(
        /[A-Z]/g,
        character =>
          character.toLowerCase()
      )
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .replace(/-+$/g, "")
      .slice(0, 48) || "operation";

    return `${prefix}:${hash}`;
  }

  id(...parts: Array<string | number>): string {
    return Once.id(...parts);
  }

  async execute(
    input: ExecuteInput
  ): Promise<ExecuteResponse> {
    if (!input.operationId) {
      throw new OnceError(
        "operationId is required.",
        {
          code: "invalid_operation_id"
        }
      );
    }

    if (!input.provider) {
      throw new OnceError(
        "provider is required.",
        {
          code: "invalid_provider"
        }
      );
    }

    return this.request<ExecuteResponse>(
      "/v1/execute",
      {
        method: "POST",
        body: JSON.stringify({
          operation_id: input.operationId,
          provider: input.provider,
          action: input.action
        })
      }
    );
  }

  async truth(
    operationId: string
  ): Promise<TruthResponse> {
    if (!operationId) {
      throw new OnceError(
        "operationId is required.",
        {
          code: "invalid_operation_id"
        }
      );
    }

    return this.request<TruthResponse>(
      `/v1/truth/${encodeURIComponent(operationId)}`,
      {
        method: "GET"
      }
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit
  ): Promise<T> {
    let lastError: unknown;

    for (
      let attempt = 0;
      attempt <= this.networkRetries;
      attempt++
    ) {
      const controller =
        new AbortController();

      const timeout = setTimeout(
        () => controller.abort(),
        this.timeoutMs
      );

      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}${path}`,
          {
            ...init,
            redirect: "error",
            signal: controller.signal,
            headers: {
              authorization:
                `Bearer ${this.apiKey}`,
              "content-type":
                "application/json",
              ...init.headers
            }
          }
        );

        const raw = await response.text();
        clearTimeout(timeout);

        let body: any = null;

        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            body = {
              message: raw
            };
          }
        }

        if (!response.ok) {
          const retryAfterHeader =
            response.headers.get(
              "retry-after"
            );

          const retryAfter =
            retryAfterHeader !== null
              ? Number(retryAfterHeader)
              : undefined;

          const code =
            body?.error ??
            body?.result ??
            `http_${response.status}`;

          const message =
            body?.message ??
            body?.error ??
            body?.result ??
            `Once returned HTTP ${response.status}`;

          throw new OnceError(
            String(message),
            {
              status:
                response.status,
              code:
                String(code),
              body,
              retryAfter:
                Number.isFinite(retryAfter)
                  ? retryAfter
                  : undefined
            }
          );
        }

        return body as T;

      } catch (error) {
        clearTimeout(timeout);

        // Once returned a real HTTP response.
        // Do not hide or automatically transform it.
        if (error instanceof OnceError) {
          throw error;
        }

        lastError = error;

        const aborted =
          error instanceof Error &&
          error.name === "AbortError";

        if (
          attempt <
          this.networkRetries
        ) {
          await sleep(
            150 * Math.pow(2, attempt)
          );

          continue;
        }

        if (aborted) {
          throw new OnceTimeoutError(
            `Once request timed out after ${this.timeoutMs}ms`,
            error
          );
        }

        throw new OnceNetworkError(
          "Could not reach Once after safe network retries",
          error
        );
      }
    }

    throw new OnceNetworkError(
      "Could not reach Once",
      lastError
    );
  }
}

function runtimeJsonContentType(
  request: Request
): boolean {

  const contentType =
    request.headers
      .get("content-type")
      ?.toLowerCase() ??
    "";

  return contentType.includes(
    "application/json"
  );
}


function assertRuntimeHeaderShape(
  request: Request
): void {

  const allowed =
    new Set([
      "content-type",
      "idempotency-key",
      "x-idempotency-key"
    ]);

  for (
    const [name]
    of request.headers
  ) {

    if (
      !allowed.has(
        name.toLowerCase()
      )
    ) {
      throw new OnceRuntimeHttpShapeError(
        `Once Runtime HTTP v0.1 cannot safely preserve target header "${name}".`
      );
    }
  }
}


function parseRuntimeReplay(
  value: unknown
): OnceRuntimeHttpReplay {

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
    value as Record<
      string,
      unknown
    >;

  const status =
    Number(
      candidate.status
    );

  /*
   * Fetch Response constructors cannot represent
   * informational 1xx responses.
   */
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
    Array.isArray(
      candidate.headers
    )
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

  const headers:
    Record<
      string,
      string
    > = {};

  for (
    const [name, headerValue]
    of Object.entries(
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

    headers[name] =
      headerValue;
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

  return {
    status,

    body_text:
      candidate.body_text,

    headers,

    ...(
      typeof candidate.recorded_at ===
        "string"
        ? {
            recorded_at:
              candidate.recorded_at
          }
        : {}
    )
  };
}


function createRuntimeCloudProtector(
  once: Once
): OnceProtectedFetchHandler {

  return async ({
    request,
    decision,
    provider
  }): Promise<Response> => {

    if (
      decision.decision !==
      "PROTECT"
    ) {
      throw new OnceError(
        "Runtime protector received a non-protected operation.",
        {
          code:
            "runtime_invalid_protect_state"
        }
      );
    }

    if (!decision.operationId) {
      throw new OnceError(
        "Runtime protected operation is missing its resolved operation ID.",
        {
          code:
            "runtime_operation_id_missing"
        }
      );
    }

    if (
      typeof provider !==
        "string" ||
      provider.trim().length ===
        0
    ) {
      throw new OnceError(
        "Runtime protected operation is missing its resolved provider.",
        {
          code:
            "runtime_provider_missing"
        }
      );
    }

    const method =
      request.method
        .trim()
        .toUpperCase();

    /*
     * Classification recognizes POST/PUT/PATCH/DELETE as
     * consequential. Execution v0.1 intentionally proves
     * only POST + JSON.
     */
    if (method !== "POST") {
      throw new OnceRuntimeHttpShapeError(
        `Once Runtime HTTP v0.1 only has a proven protected execution contract for POST, not ${method || "(empty)"}.`
      );
    }

    if (
      !runtimeJsonContentType(
        request
      )
    ) {
      throw new OnceRuntimeHttpShapeError(
        "Once Runtime HTTP v0.1 only protects application/json POST bodies."
      );
    }

    assertRuntimeHeaderShape(
      request
    );

    const bodyText =
      await request
        .clone()
        .text();

    if (
      bodyText.trim().length ===
      0
    ) {
      throw new OnceRuntimeHttpShapeError(
        "Once Runtime HTTP v0.1 requires a non-empty JSON body."
      );
    }

    try {
      JSON.parse(
        bodyText
      );
    } catch {
      throw new OnceRuntimeHttpShapeError(
        "Once Runtime HTTP v0.1 requires a valid JSON body."
      );
    }

    const result =
      await once.execute({
        operationId:
          decision.operationId,

        provider:
          provider.trim(),

        action: {
          type:
            "http_write_v1",

          method:
            "POST",

          url:
            request.url,

          body_json:
            bodyText
        }
      });

    const replay =
      parseRuntimeReplay(
        result.http_response
      );

    const nullBody =
      replay.status === 204 ||
      replay.status === 205 ||
      replay.status === 304;

    return new Response(
      nullBody
        ? null
        : replay.body_text,
      {
        status:
          replay.status,

        headers:
          replay.headers
      }
    );
  };
}


/**
 * Create a fetch-compatible Once Runtime.
 *
 * v0.1 proven protected execution shape:
 * POST + application/json + stable identity.
 */
export function createOnceRuntimeFetch(
  options:
    OnceRuntimeFetchOptions = {}
): typeof fetch {

  const originalFetch =
    options.fetchImpl ??
    globalThis.fetch;

  if (
    typeof originalFetch !==
    "function"
  ) {
    throw new OnceError(
      "Once Runtime requires a native fetch implementation.",
      {
        code:
          "runtime_fetch_missing"
      }
    );
  }

  /*
   * Once Cloud requests use the captured native fetch.
   * They cannot recursively enter this interceptor.
   */
  const once =
    new Once({
      apiKey:
        options.apiKey,

      baseUrl:
        options.baseUrl,

      timeoutMs:
        options.timeoutMs,

      networkRetries:
        options.networkRetries,

      fetchImpl:
        originalFetch
    });

  return createOnceFetchInterceptor({
    provider:
      options.provider,

    shouldProtect:
      options.shouldProtect,

    resolveProvider:
      options.resolveProvider,

    resolveOperationId:
      options.resolveOperationId,

    fetchImpl:
      originalFetch,

    protect:
      createRuntimeCloudProtector(
        once
      )
  });
}


/**
 * Explicit reversible global fetch installation.
 */
export function installOnceRuntimeFetch(
  options:
    OnceRuntimeFetchOptions = {}
): OnceFetchInstallation {

  const previous =
    globalThis.fetch;

  const intercepted =
    createOnceRuntimeFetch({
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

export {
  createOnceFetchInterceptor,
  installOnceFetchInterceptor,
  OnceRuntimeBlockedError
} from "./runtime/fetch-interceptor.js";

export type {
  OnceFetchInstallation,
  OnceFetchInterceptorOptions,
  OnceProtectedFetchContext,
  OnceProtectedFetchHandler
} from "./runtime/fetch-interceptor.js";

export {
  prepareHttpExecution
} from "./runtime/pipeline.js";

export {
  decideHttpExecution
} from "./runtime/decision.js";

export {
  resolveHttpOperationIdentity
} from "./runtime/identity.js";

export default Once;

/*
 * Once Connect
 *
 * Framework-neutral execution-safety boundary for agent/tool integrations.
 * Protected execution delegates to the existing Once kernel.
 */
export {
  CONNECT_DECISION,
  classifyConnectOperation
} from "./connect/classifier.js";

export type {
  ConnectDecision,
  ConnectSafetyDeclaration,
  ConnectClassification
} from "./connect/classifier.js";

export {
  ConnectBindingError,
  canonicalizeConnectPayload,
  fingerprintConnectPayload,
  bindConnectOperation,
  assertConnectBindingMatch
} from "./connect/binding.js";

export type {
  ConnectPayload,
  ConnectBinding
} from "./connect/binding.js";

export {
  ConnectExecutionError,
  executeConnectOperation
} from "./connect/execute.js";

export type {
  ConnectProtectedContext,
  ConnectExecutionInput
} from "./connect/execute.js";

export {
  ConnectKernelError,
  executeConnectWithOnce
} from "./connect/kernel.js";

export type {
  ConnectKernelInput
} from "./connect/kernel.js";

export {
  OpenAIAgentsConnectError,
  executeOpenAIAgentsConnectTool
} from "./connect/openai-agents.js";

export type {
  OpenAIAgentsToolInput,
  OpenAIAgentsAction,
  OpenAIAgentsConnectToolInput
} from "./connect/openai-agents.js";

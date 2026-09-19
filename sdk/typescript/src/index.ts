import { Buffer } from "node:buffer";
﻿import { createHash } from "node:crypto";

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

        clearTimeout(timeout);

        const raw = await response.text();

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

export default Once;

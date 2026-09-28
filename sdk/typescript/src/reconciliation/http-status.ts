import {
  createProviderReconciliationAdapter,
  type ProviderLookup,
  type ProviderReconciliationAdapter,
  type ProviderReconciliationContext,
} from "./provider.js";

type JsonObject =
  Record<string, unknown>;

export type HttpStatusFoundRecord<Result> = Readonly<{
  operationId: string;
  payload: JsonObject;
  result: Result;
}>;

export type HttpStatusResponseSnapshot = Readonly<{
  status: number;
  headers: Headers;
  body: unknown;
}>;

export interface HttpStatusReconciliationOptions<Result> {
  /** Label identifying the provider truth surface used for evidence. */
  source?: string;

  /** Resolve the read-only status URL for this exact logical operation. */
  url(
    context: ProviderReconciliationContext,
  ): string | URL;

  /**
   * Convert a successful provider status response into the exact operation ID,
   * effect-bearing payload and replayable receipt Once should bind.
   */
  decodeFound(
    response: HttpStatusResponseSnapshot,
    context: ProviderReconciliationContext,
  ): Promise<HttpStatusFoundRecord<Result>> | HttpStatusFoundRecord<Result>;

  /**
   * Explicit opt-in only. 404/410 are treated as ABSENT_PROVEN only when the
   * provider contract guarantees that response is authoritative for this exact
   * operation ID. By default, no HTTP status proves absence.
   */
  authoritativeAbsenceStatuses?: readonly (404 | 410)[];

  /** Optional authentication or provider headers for the read-only lookup. */
  headers?:
    | Readonly<Record<string, string>>
    | ((
        context: ProviderReconciliationContext,
      ) => Readonly<Record<string, string>>);

  /** Read-only lookup timeout. Defaults to 5000 ms. */
  timeoutMs?: number;

  /** Injectable fetch for runtimes/tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

function validateTimeout(
  timeoutMs: number,
): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000
  ) {
    throw new Error(
      "HTTP reconciliation timeoutMs must be an integer from 1 to 60000.",
    );
  }
}

function validateUrl(
  value: string | URL,
): URL {
  const url =
    value instanceof URL
      ? new URL(value.toString())
      : new URL(value);

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    throw new Error(
      "HTTP reconciliation status URLs must use http or https.",
    );
  }

  return url;
}

function copyHeaders(
  value: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const result:
    Record<string, string> = {};

  if (!value) {
    return result;
  }

  for (const [name, headerValue] of Object.entries(value)) {
    if (
      typeof headerValue !== "string" ||
      name.trim() === ""
    ) {
      throw new Error(
        "HTTP reconciliation headers must have nonempty names and string values.",
      );
    }

    result[name] = headerValue;
  }

  return result;
}

export function createHttpStatusReconciliationAdapter<Result>(
  options: HttpStatusReconciliationOptions<Result>,
): ProviderReconciliationAdapter<Result> {
  if (
    !options ||
    typeof options.url !== "function" ||
    typeof options.decodeFound !== "function"
  ) {
    throw new Error(
      "HTTP reconciliation requires url() and decodeFound() callbacks.",
    );
  }

  const timeoutMs =
    options.timeoutMs ?? 5_000;

  validateTimeout(timeoutMs);

  const absenceStatuses =
    new Set<number>(
      options.authoritativeAbsenceStatuses ?? [],
    );

  for (const status of absenceStatuses) {
    if (status !== 404 && status !== 410) {
      throw new Error(
        "Only explicit 404 or 410 provider contracts may be configured as authoritative HTTP absence evidence.",
      );
    }
  }

  const fetchImpl =
    options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error(
      "HTTP reconciliation requires a fetch implementation.",
    );
  }

  const source =
    options.source?.trim() ||
    "authoritative-http-status";

  return createProviderReconciliationAdapter<Result>({
    source,

    lookup:
      async (
        context,
      ): Promise<ProviderLookup<Result>> => {
        const url =
          validateUrl(
            options.url(context),
          );

        const headers =
          copyHeaders(
            typeof options.headers === "function"
              ? options.headers(context)
              : options.headers,
          );

        const controller =
          new AbortController();

        const timeout =
          setTimeout(
            () => controller.abort(),
            timeoutMs,
          );

        let response: Response;

        try {
          response =
            await fetchImpl(
              url,
              {
                method: "GET",
                headers,
                redirect: "error",
                signal: controller.signal,
              },
            );
        } finally {
          clearTimeout(timeout);
        }

        if (absenceStatuses.has(response.status)) {
          return {
            kind: "ABSENT_PROVEN",
            source,
            detail:
              `Provider status endpoint returned authoritative HTTP ${response.status} for this operation ID.`,
          };
        }

        if (!response.ok) {
          return {
            kind: "UNKNOWN",
            source,
            detail:
              `Provider status endpoint returned HTTP ${response.status}; this status is not configured as authoritative absence evidence.`,
          };
        }

        const text =
          await response.text();

        let body: unknown = null;

        if (text !== "") {
          try {
            body = JSON.parse(text);
          } catch {
            return {
              kind: "UNKNOWN",
              source,
              detail:
                "Provider status endpoint returned a successful response whose body was not valid JSON.",
            };
          }
        }

        const found =
          await options.decodeFound(
            {
              status: response.status,
              headers: response.headers,
              body,
            },
            context,
          );

        if (
          !found ||
          typeof found.operationId !== "string" ||
          found.operationId.trim() === "" ||
          found.payload === null ||
          typeof found.payload !== "object" ||
          Array.isArray(found.payload)
        ) {
          return {
            kind: "UNKNOWN",
            source,
            detail:
              "Provider status decoder did not return a usable operation identity and effect payload.",
          };
        }

        return {
          kind: "FOUND",
          source,
          operationId: found.operationId,
          payload: found.payload,
          result: found.result,
        };
      },
  });
}

export const HTTP_RESPONSE_REPLAY_V2_CONTRACT = "http_response_replay_v2" as const;

export type HttpResponseReplayV2Type = "basic" | "cors" | "default";

export type HttpResponseReplayV2 = {
  contract: typeof HTTP_RESPONSE_REPLAY_V2_CONTRACT;
  status: number;
  status_text: string;
  headers_entries: Array<[string, string]>;
  body_present: boolean;
  body_base64: string;
  body_length: number;
  url: string;
  redirected: boolean;
  type: HttpResponseReplayV2Type;
};

export class HttpResponseReplayV2Error extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "HttpResponseReplayV2Error";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new HttpResponseReplayV2Error(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(
      "invalid_http_response_replay_v2_shape",
      `${label} must contain exactly: ${wanted.join(", ")}.`
    );
  }
}

function requireString(
  value: unknown,
  label: string,
  { allowEmpty = true }: { allowEmpty?: boolean } = {}
): string {
  if (typeof value !== "string") {
    fail("invalid_http_response_replay_v2_string", `${label} must be a string.`);
  }
  if (!allowEmpty && value.length === 0) {
    fail("invalid_http_response_replay_v2_string", `${label} must not be empty.`);
  }
  return value;
}

function decodeCanonicalBase64(value: unknown): Uint8Array {
  const base64 = requireString(value, "body_base64");
  let binary: string;
  try {
    binary = atob(base64);
  } catch (error) {
    fail(
      "invalid_http_response_replay_v2_base64",
      "body_base64 must be valid base64.",
      error
    );
  }
  if (btoa(binary) !== base64) {
    fail(
      "invalid_http_response_replay_v2_base64",
      "body_base64 must use canonical base64 encoding."
    );
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function encodeCanonicalBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + chunkSize, bytes.byteLength)
    );
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function requireStatus(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 200 || Number(value) > 599) {
    fail(
      "invalid_http_response_replay_v2_status",
      "status must be an integer from 200 through 599."
    );
  }
  return Number(value);
}

function requireStatusText(value: unknown, status: number): string {
  const statusText = requireString(value, "status_text");
  try {
    const probe = new Response(null, { status, statusText });
    if (probe.statusText !== statusText) {
      fail(
        "noncanonical_http_response_replay_v2_status_text",
        "status_text must survive native Response normalization unchanged."
      );
    }
  } catch (error) {
    if (error instanceof HttpResponseReplayV2Error) throw error;
    fail(
      "invalid_http_response_replay_v2_status_text",
      "status_text is not valid native Response metadata.",
      error
    );
  }
  return statusText;
}

function requireUrl(value: unknown): string {
  const url = requireString(value, "url", { allowEmpty: false });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    fail(
      "invalid_http_response_replay_v2_url",
      "url must be an absolute HTTP(S) URL.",
      error
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.toString() !== url
  ) {
    fail(
      "invalid_http_response_replay_v2_url",
      "url must be an exact canonical HTTP(S) URL without credentials or a fragment."
    );
  }
  return url;
}

function requireType(value: unknown): HttpResponseReplayV2Type {
  if (value === "basic" || value === "cors" || value === "default") return value;
  fail(
    "unsupported_http_response_replay_v2_type",
    "type must be exact basic, cors, or default. Opaque/error response types are not replayed as native responses."
  );
}

function requireHeaderEntries(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) {
    fail("invalid_http_response_replay_v2_headers", "headers_entries must be an array.");
  }

  const entries: Array<[string, string]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      fail(
        "invalid_http_response_replay_v2_headers",
        "Each headers_entries item must be an exact [name, value] pair."
      );
    }
    const name = requireString(entry[0], "header name", { allowEmpty: false });
    const headerValue = requireString(entry[1], "header value");
    if (name !== name.toLowerCase()) {
      fail(
        "noncanonical_http_response_replay_v2_headers",
        "Header names must already use native lower-case canonical form."
      );
    }
    entries.push([name, headerValue]);
  }

  let canonical: Array<[string, string]>;
  try {
    canonical = Array.from(new Headers(entries).entries());
  } catch (error) {
    fail(
      "invalid_http_response_replay_v2_headers",
      "headers_entries contains an invalid native Headers value.",
      error
    );
  }

  if (JSON.stringify(canonical) !== JSON.stringify(entries)) {
    fail(
      "noncanonical_http_response_replay_v2_headers",
      "headers_entries must already match native Headers canonical iteration exactly."
    );
  }
  return entries;
}

function copyReceipt(receipt: HttpResponseReplayV2): HttpResponseReplayV2 {
  return {
    ...receipt,
    headers_entries: receipt.headers_entries.map(([name, value]) => [name, value])
  };
}

export function validateHttpResponseReplayV2(value: unknown): HttpResponseReplayV2 {
  if (!isPlainObject(value)) {
    fail(
      "invalid_http_response_replay_v2_shape",
      "HTTP response replay v2 receipt must be a plain object."
    );
  }

  requireExactKeys(
    value,
    [
      "contract",
      "status",
      "status_text",
      "headers_entries",
      "body_present",
      "body_base64",
      "body_length",
      "url",
      "redirected",
      "type"
    ],
    "HTTP response replay v2 receipt"
  );

  if (value.contract !== HTTP_RESPONSE_REPLAY_V2_CONTRACT) {
    fail(
      "unsupported_http_response_replay_v2_contract",
      `contract must be exact ${HTTP_RESPONSE_REPLAY_V2_CONTRACT}.`
    );
  }

  const status = requireStatus(value.status);
  const statusText = requireStatusText(value.status_text, status);
  const headers = requireHeaderEntries(value.headers_entries);

  if (typeof value.body_present !== "boolean") {
    fail(
      "invalid_http_response_replay_v2_body_presence",
      "body_present must be boolean."
    );
  }

  const bytes = decodeCanonicalBase64(value.body_base64);
  if (
    !Number.isSafeInteger(value.body_length) ||
    Number(value.body_length) < 0 ||
    bytes.byteLength !== Number(value.body_length)
  ) {
    fail(
      "invalid_http_response_replay_v2_body_length",
      "body_length must exactly equal the decoded body byte length."
    );
  }

  if (value.body_present === false && bytes.byteLength !== 0) {
    fail(
      "invalid_http_response_replay_v2_body_presence",
      "A null response body cannot carry replay bytes."
    );
  }

  if ((status === 204 || status === 205 || status === 304) && value.body_present) {
    fail(
      "invalid_http_response_replay_v2_body_presence",
      "Native null-body statuses cannot carry a replay body."
    );
  }

  const url = requireUrl(value.url);
  if (typeof value.redirected !== "boolean") {
    fail(
      "invalid_http_response_replay_v2_redirected",
      "redirected must be boolean."
    );
  }
  const responseType = requireType(value.type);

  return {
    contract: HTTP_RESPONSE_REPLAY_V2_CONTRACT,
    status,
    status_text: statusText,
    headers_entries: headers,
    body_present: value.body_present,
    body_base64: requireString(value.body_base64, "body_base64"),
    body_length: Number(value.body_length),
    url,
    redirected: value.redirected,
    type: responseType
  };
}

export async function captureHttpResponseReplayV2(
  response: Response
): Promise<HttpResponseReplayV2> {
  if (!(response instanceof Response)) {
    fail(
      "invalid_http_response_replay_v2_source",
      "capture source must be a native Response."
    );
  }
  if (response.bodyUsed) {
    fail(
      "used_http_response_replay_v2_source",
      "capture source body must not already be used."
    );
  }

  const status = requireStatus(response.status);
  const statusText = requireStatusText(response.statusText, status);
  const headers = requireHeaderEntries(Array.from(response.headers.entries()));
  const url = requireUrl(response.url);
  const responseType = requireType(response.type);
  const bodyPresent = response.body !== null;
  const bytes = bodyPresent
    ? new Uint8Array(await response.arrayBuffer())
    : new Uint8Array();

  return validateHttpResponseReplayV2({
    contract: HTTP_RESPONSE_REPLAY_V2_CONTRACT,
    status,
    status_text: statusText,
    headers_entries: headers,
    body_present: bodyPresent,
    body_base64: encodeCanonicalBase64(bytes),
    body_length: bytes.byteLength,
    url,
    redirected: response.redirected,
    type: responseType
  });
}

function immutableHeaders(entries: Array<[string, string]>): Headers {
  const headers = new Headers(entries);
  const rejectMutation = () => {
    throw new TypeError("immutable");
  };
  Object.defineProperties(headers, {
    append: { value: rejectMutation, writable: false, configurable: false },
    delete: { value: rejectMutation, writable: false, configurable: false },
    set: { value: rejectMutation, writable: false, configurable: false }
  });
  return headers;
}

const USE_RECEIPT_BODY = Symbol("USE_RECEIPT_BODY");

class ReplayedHttpResponseV2 extends Response {
  readonly #receipt: HttpResponseReplayV2;
  readonly #headers: Headers;

  constructor(
    receipt: HttpResponseReplayV2,
    bodyOverride: BodyInit | null | typeof USE_RECEIPT_BODY = USE_RECEIPT_BODY
  ) {
    const validated = validateHttpResponseReplayV2(receipt);
    const body: BodyInit | null = bodyOverride === USE_RECEIPT_BODY
      ? (
          validated.body_present
            ? bytesToArrayBuffer(decodeCanonicalBase64(validated.body_base64))
            : null
        )
      : bodyOverride;

    super(body, {
      status: validated.status,
      statusText: validated.status_text,
      headers: validated.headers_entries
    });

    this.#receipt = copyReceipt(validated);
    this.#headers = immutableHeaders(validated.headers_entries);
  }

  override get headers(): Headers {
    return this.#headers;
  }

  override get url(): string {
    return this.#receipt.url;
  }

  override get redirected(): boolean {
    return this.#receipt.redirected;
  }

  override get type(): ResponseType {
    return this.#receipt.type;
  }

  override clone(): Response {
    const nativeClone = super.clone();
    return new ReplayedHttpResponseV2(this.#receipt, nativeClone.body);
  }
}

export function reconstructHttpResponseReplayV2(value: unknown): Response {
  return new ReplayedHttpResponseV2(validateHttpResponseReplayV2(value));
}

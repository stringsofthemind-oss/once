export const HTTP_WRITE_TRANSFORMER_ID =
  "ts_fetch_post_void_v1" as const;

export type HttpWriteTransformInput = {
  statement: string;
  functionSource: string;
  provider: string;
};

export type HttpWriteTransformSuccess = {
  eligible: true;
  transformer:
    typeof HTTP_WRITE_TRANSFORMER_ID;
  replacement: string;
  actionType: "http_write_v1";
  method: "POST";
  url: string;
  bodyExpression: string;
  requiresOnceBinding: true;
};

export type HttpWriteTransformFailure = {
  eligible: false;
  reason: string;
};

export type HttpWriteTransformResult =
  | HttpWriteTransformSuccess
  | HttpWriteTransformFailure;

function hasOperationIdParameter(
  functionSource: string
): boolean {

  const match =
    functionSource.match(
      /\(([^)]*)\)/
    );

  if (!match) {
    return false;
  }

  const parameters =
    match[1]
      .split(",")
      .map(
        parameter =>
          parameter
            .trim()
            .replace(
              /^\.\.\./,
              ""
            )
            .split(/[:=]/)[0]
            .trim()
      );

  return parameters.includes(
    "operationId"
  );
}

function quote(
  value: string
): string {

  return JSON.stringify(
    value
  );
}

export function transformHttpWriteV1(
  input: HttpWriteTransformInput
): HttpWriteTransformResult {

  const provider =
    input.provider.trim();

  if (!provider) {
    return {
      eligible: false,
      reason:
        "A configured provider is required."
    };
  }

  if (
    !hasOperationIdParameter(
      input.functionSource
    )
  ) {
    return {
      eligible: false,
      reason:
        "The surrounding function must already receive a stable operationId parameter."
    };
  }

  const statement =
    input.statement
      .replace(
        /\r\n/g,
        "\n"
      )
      .trim();

  /*
   * Deliberately require an unused-response
   * await fetch(...) expression statement.
   *
   * return await fetch(...)
   * const x = await fetch(...)
   *
   * are not accepted because Once.execute()
   * does not have the same return contract as
   * the native Fetch Response object.
   */
  if (
    !/^await\s+fetch\s*\(/.test(
      statement
    )
  ) {
    return {
      eligible: false,
      reason:
        "Only an unused-response `await fetch(...)` statement is supported."
    };
  }

  const callMatch =
    statement.match(
      /^await\s+fetch\s*\(\s*(["'])(https:\/\/[^"'\\]+)\1\s*,\s*\{([\s\S]*)\}\s*\)\s*;?$/
    );

  if (!callMatch) {
    return {
      eligible: false,
      reason:
        "Only a literal HTTPS URL and an inline fetch options object are supported."
    };
  }

  const url =
    callMatch[2];

  const options =
    callMatch[3];

  /*
   * v0.6 allows exactly two fetch options:
   *
   * method
   * body
   *
   * Anything else requires a richer
   * semantics-preserving transformer.
   */
  const keys =
    Array.from(
      options.matchAll(
        /(?:^|,|\n)\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g
      ),
      match =>
        match[1]
    );

  const uniqueKeys =
    Array.from(
      new Set(keys)
    ).sort();

  if (
    uniqueKeys.length !== 2 ||
    uniqueKeys[0] !== "body" ||
    uniqueKeys[1] !== "method"
  ) {
    return {
      eligible: false,
      reason:
        "v0.6 supports exactly the fetch options `method` and `body`."
    };
  }

  const methodMatch =
    options.match(
      /\bmethod\s*:\s*(["'])POST\1/
    );

  if (!methodMatch) {
    return {
      eligible: false,
      reason:
        "v0.6 supports only literal POST requests."
    };
  }

  const bodyMatch =
    options.match(
      /\bbody\s*:\s*JSON\.stringify\(\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\)/
    );

  if (!bodyMatch) {
    return {
      eligible: false,
      reason:
        "v0.6 requires body: JSON.stringify(<simple expression>)."
    };
  }

  const bodyExpression =
    bodyMatch[1];

  /*
   * Ensure the recognized expressions account
   * for the expected option values rather than
   * accepting an object containing additional
   * unsupported executable syntax.
   */
  const methodOccurrences =
    (
      options.match(
        /\bmethod\s*:/g
      ) ?? []
    ).length;

  const bodyOccurrences =
    (
      options.match(
        /\bbody\s*:/g
      ) ?? []
    ).length;

  if (
    methodOccurrences !== 1 ||
    bodyOccurrences !== 1
  ) {
    return {
      eligible: false,
      reason:
        "Duplicate method/body options are not supported."
    };
  }

  const replacement = [
    "await once.execute({",
    "  operationId,",
    `  provider: ${quote(provider)},`,
    "  action: {",
    '    type: "http_write_v1",',
    '    method: "POST",',
    `    url: ${quote(url)},`,
    `    body_json: JSON.stringify(${bodyExpression})`,
    "  }",
    "});"
  ].join("\n");

  return {
    eligible: true,
    transformer:
      HTTP_WRITE_TRANSFORMER_ID,
    replacement,
    actionType:
      "http_write_v1",
    method:
      "POST",
    url,
    bodyExpression,
    requiresOnceBinding:
      true
  };
}
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
  method: "POST" | "PUT" | "PATCH" | "DELETE";
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

  const functionSource =
    input.functionSource;

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
   * Supported fetch options are either:
   *
   * method + body
   *
   * or method + body + the exact static
   * Content-Type: application/json header.
   *
   * Arbitrary headers still require a richer
   * semantics-preserving action/runtime contract.
   *
   * In particular, source Authorization headers
   * must not be copied into the protected action:
   * registered provider authorization is resolved
   * separately by the Once runtime.
   *
   * Until http_write_v1 can carry and execute
   * arbitrary headers with equivalent semantics,
   * additional, dynamic, referenced, spread, and
   * Authorization headers remain fail-closed.
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

  /*
   * Fail closed on shorthand headers such as:
   *
   *   { method: "POST", headers, body: ... }
   *
   * The explicit key:value extraction above does
   * not count shorthand object properties.
   */
  const shorthandHeaders =
    /(?:^|,|\n)\s*headers\s*(?=,|\n|$)/.test(
      options
    );


  const baseShape =
    uniqueKeys.length === 2 &&
    uniqueKeys[0] === "body" &&
    uniqueKeys[1] === "method";

  const explicitHeaderReferenceMatch =
    options.match(
      /\bheaders\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=,|\n|$)/
    );

  const headerReferenceCandidate =
    shorthandHeaders ||
    explicitHeaderReferenceMatch !== null;

  const jsonHeaderShape =
    (
      uniqueKeys.length === 3 &&
      uniqueKeys[0] === "body" &&
      uniqueKeys[1] === "headers" &&
      uniqueKeys[2] === "method"
    ) ||
    (
      headerReferenceCandidate &&
      uniqueKeys.length === 2 &&
      uniqueKeys[0] === "body" &&
      uniqueKeys[1] === "method"
    );

  if (
    !baseShape &&
    !jsonHeaderShape
  ) {
    return {
      eligible: false,
      reason:
        "Supports `method` and `body`, optionally with the exact static JSON Content-Type header."
    };
  }

  const resolveStaticHeaderReference =
    (identifier: string): string | undefined => {
      const escapedIdentifier =
        identifier.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        );

      const declarationPattern =
        new RegExp(
          String.raw`\bconst\s+${escapedIdentifier}\s*=\s*\{([\s\S]*?)\}\s*;`,
          "g"
        );

      const declarations =
        Array.from(
          functionSource.matchAll(
            declarationPattern
          )
        );

      if (declarations.length !== 1) {
        return undefined;
      }

      const objectBody =
        declarations[0]?.[1];

      if (objectBody === undefined) {
        return undefined;
      }

      if (
        objectBody.includes("...") ||
        objectBody.includes("[") ||
        objectBody.includes("]") ||
        objectBody.includes("`") ||
        objectBody.includes("${")
      ) {
        return undefined;
      }

      const entryPattern =
        /(["'])([^"'\\\r\n]+)\1\s*:\s*(["'])([^"'\\\r\n]*)\3\s*(?:,|$)/g;

      const entries =
        Array.from(
          objectBody.matchAll(
            entryPattern
          )
        );

      const remainder =
        objectBody
          .replace(entryPattern, "")
          .trim();

      if (
        entries.length === 0 ||
        remainder !== ""
      ) {
        return undefined;
      }

      const headers: Record<string, string> = {};

      for (const entry of entries) {
        const rawName = entry[2];
        const value = entry[4];

        if (
          rawName === undefined ||
          value === undefined
        ) {
          return undefined;
        }

        const name =
          rawName.toLowerCase();

        if (
          name !== "content-type" &&
          name !== "x-api-version"
        ) {
          return undefined;
        }

        if (
          Object.prototype.hasOwnProperty.call(
            headers,
            name
          )
        ) {
          return undefined;
        }

        if (
          name === "content-type" &&
          value !== "application/json"
        ) {
          return undefined;
        }

        headers[name] = value;
      }

      const identifierOccurrences =
        (
          functionSource.match(
            new RegExp(
              String.raw`\b${escapedIdentifier}\b`,
              "g"
            )
          ) ?? []
        ).length;

      if (identifierOccurrences !== 2) {
        return undefined;
      }

      return JSON.stringify(headers);
    };

  let preservedHeadersJson: string | undefined;

  if (jsonHeaderShape) {
    const headerMatch =
      options.match(
        /\bheaders\s*:\s*\{\s*(["'])Content-Type\1\s*:\s*(["'])application\/json\2(?:\s*,\s*(["'])X-API-Version\3\s*:\s*(["'])([^"'\\\r\n]+)\4)?\s*\}/
      );

    const shorthandHeaderReferenceMatch =
      shorthandHeaders
        ? options.match(
            /(?:^|,|\n)\s*(headers)\s*(?=,|\n|$)/
          )
        : null;

    const explicitHeaderReference =
      explicitHeaderReferenceMatch?.[1];

    const shorthandHeaderReference =
      shorthandHeaderReferenceMatch?.[1];

    const headerReference =
      explicitHeaderReference ??
      shorthandHeaderReference;

    const explicitHeaderOccurrences =
      (
        options.match(/\bheaders\s*:/g) ?? []
      ).length;

    const shorthandHeaderOccurrences =
      shorthandHeaders ? 1 : 0;

    const headerOccurrences =
      explicitHeaderOccurrences +
      shorthandHeaderOccurrences;

    if (headerOccurrences !== 1) {
      return {
        eligible: false,
        reason:
          "Only bounded static JSON headers are supported."
      };
    }

    if (headerMatch) {
      if (headerMatch[5] !== undefined) {
        preservedHeadersJson =
          JSON.stringify({
            "content-type":
              "application/json",
            "x-api-version":
              headerMatch[5]
          });
      }
    }
    else if (headerReference !== undefined) {
      const resolvedHeaders =
        resolveStaticHeaderReference(
          headerReference
        );

      if (resolvedHeaders === undefined) {
        if (
          shorthandHeaders &&
          headerReference === "headers"
        ) {
          return {
            eligible: false,
            reason:
              "Only the exact static `Content-Type: application/json` header is supported."
          };
        }

        return {
          eligible: false,
          reason:
            "Static header reference could not be resolved safely."
        };
      }

      preservedHeadersJson =
        resolvedHeaders;
    }
    else {
      return {
        eligible: false,
        reason:
          "Only bounded static JSON headers are supported."
      };
    }
  }

  const methodMatch =
    options.match(
      /\bmethod\s*:\s*(["'])(POST|PUT|PATCH|DELETE)\1/
    );

  if (!methodMatch) {
    return {
      eligible: false,
      reason:
        "Supports only exact literal POST, PUT, PATCH, or DELETE requests."
    };
  }

  const method =
    methodMatch[2] as "POST" | "PUT" | "PATCH" | "DELETE";

  const bodyMatch =
    options.match(
      /\bbody\s*:\s*JSON\.stringify\(\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\)/
    );

  if (!bodyMatch) {
    return {
      eligible: false,
      reason:
        "Requires body: JSON.stringify(<simple expression>)."
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
    `    method: ${quote(method)},`,
    `    url: ${quote(url)},`,
    ...(preservedHeadersJson !== undefined
      ? [
          `    headers_json: ${quote(preservedHeadersJson)},`
        ]
      : []),
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
    method,
    url,
    bodyExpression,
    requiresOnceBinding:
      true
  };
}

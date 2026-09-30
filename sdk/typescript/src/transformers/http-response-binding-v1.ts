export const HTTP_RESPONSE_HELPER_ALIAS =
  "__OnceAgentHttpResponse" as const;

export const HTTP_RESPONSE_HELPER_IMPORT =
  'import { executeHttpWriteResponse as __OnceAgentHttpResponse } from "@once-agent/sdk/http-response";' as const;

export type HttpResponseBindingSuccess = {
  eligible: true;
  importStatement:
    typeof HTTP_RESPONSE_HELPER_IMPORT;
  helperAlias:
    typeof HTTP_RESPONSE_HELPER_ALIAS;
  sourceWithImport: string;
  boundReplacement: string;
};

export type HttpResponseBindingFailure = {
  eligible: false;
  reason: string;
};

export type HttpResponseBindingResult =
  | HttpResponseBindingSuccess
  | HttpResponseBindingFailure;

function hasEsmSyntax(
  source: string
): boolean {
  return (
    /(^|\n)\s*import\s+/m.test(source) ||
    /(^|\n)\s*export\s+/m.test(source)
  );
}

function aliasExists(
  source: string
): boolean {
  return new RegExp(
    `\\b${HTTP_RESPONSE_HELPER_ALIAS}\\b`
  ).test(source);
}

function findImportInsertionOffset(
  source: string
): number {
  let cursor =
    source.charCodeAt(0) === 0xFEFF
      ? 1
      : 0;

  if (source.startsWith("#!", cursor)) {
    const newline =
      source.indexOf("\n", cursor);

    cursor =
      newline < 0
        ? source.length
        : newline + 1;
  }

  let search = cursor;
  let lastDirectiveEnd = cursor;

  while (search < source.length) {
    const whitespace =
      source
        .slice(search)
        .match(/^[ \t\r\n]+/);

    if (whitespace) {
      search += whitespace[0].length;
    }

    if (source.startsWith("//", search)) {
      const newline =
        source.indexOf("\n", search);

      search =
        newline < 0
          ? source.length
          : newline + 1;
      continue;
    }

    if (source.startsWith("/*", search)) {
      const close =
        source.indexOf("*/", search + 2);

      if (close < 0) {
        return cursor;
      }

      search = close + 2;
      continue;
    }

    const directive =
      source
        .slice(search)
        .match(/^(["'])(?:\\.|(?!\1)[^\\\r\n])*\1\s*;?/);

    if (!directive) {
      break;
    }

    search += directive[0].length;

    const newline =
      source.indexOf("\n", search);

    lastDirectiveEnd =
      newline < 0
        ? source.length
        : newline + 1;

    search = lastDirectiveEnd;
  }

  return lastDirectiveEnd;
}

function insertImport(
  source: string
): string {
  const offset =
    findImportInsertionOffset(source);

  const before =
    source.slice(0, offset);

  const after =
    source.slice(offset);

  const separatorBefore =
    before.length > 0 &&
    !before.endsWith("\n")
      ? "\n"
      : "";

  return (
    before +
    separatorBefore +
    HTTP_RESPONSE_HELPER_IMPORT +
    "\n" +
    after
  );
}

export function bindHttpResponseHelperV1(
  source: string,
  replacement: string
): HttpResponseBindingResult {
  if (!hasEsmSyntax(source)) {
    return {
      eligible: false,
      reason:
        "Native HTTP Response automatic binding supports ESM modules only."
    };
  }

  if (aliasExists(source)) {
    return {
      eligible: false,
      reason:
        `Reserved native HTTP Response helper alias ${HTTP_RESPONSE_HELPER_ALIAS} already exists in the source file.`
    };
  }

  const calls =
    replacement.match(
      /\bawait\s+executeHttpWriteResponse\s*\(/g
    ) ?? [];

  if (calls.length !== 1) {
    return {
      eligible: false,
      reason:
        "Expected exactly one transformer-generated native HTTP Response helper call."
    };
  }

  const boundReplacement =
    replacement.replace(
      /\bawait\s+executeHttpWriteResponse\s*\(/,
      `await ${HTTP_RESPONSE_HELPER_ALIAS}(`
    );

  if (
    /\bexecuteHttpWriteResponse\s*\(/.test(
      boundReplacement
    )
  ) {
    return {
      eligible: false,
      reason:
        "Generated native HTTP Response binding left an unbound helper call."
    };
  }

  return {
    eligible: true,
    importStatement:
      HTTP_RESPONSE_HELPER_IMPORT,
    helperAlias:
      HTTP_RESPONSE_HELPER_ALIAS,
    sourceWithImport:
      insertImport(source),
    boundReplacement
  };
}

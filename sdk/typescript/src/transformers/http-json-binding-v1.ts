export const HTTP_JSON_HELPER_ALIAS =
  "__OnceAgentHttpJson" as const;

export const HTTP_JSON_HELPER_IMPORT =
  'import { executeHttpWriteJsonResponse as __OnceAgentHttpJson } from "@once-agent/sdk/http-response-json";' as const;

export type HttpJsonBindingSuccess = {
  eligible: true;
  importStatement:
    typeof HTTP_JSON_HELPER_IMPORT;
  helperAlias:
    typeof HTTP_JSON_HELPER_ALIAS;
  sourceWithImport: string;
  boundReplacement: string;
};

export type HttpJsonBindingFailure = {
  eligible: false;
  reason: string;
};

export type HttpJsonBindingResult =
  | HttpJsonBindingSuccess
  | HttpJsonBindingFailure;

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
    `\\b${HTTP_JSON_HELPER_ALIAS}\\b`
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
    HTTP_JSON_HELPER_IMPORT +
    "\n" +
    after
  );
}

export function bindHttpJsonHelperV1(
  source: string,
  replacement: string
): HttpJsonBindingResult {
  if (!hasEsmSyntax(source)) {
    return {
      eligible: false,
      reason:
        "HTTP JSON automatic binding supports ESM modules only."
    };
  }

  if (aliasExists(source)) {
    return {
      eligible: false,
      reason:
        `Reserved HTTP JSON helper alias ${HTTP_JSON_HELPER_ALIAS} already exists in the source file.`
    };
  }

  const calls =
    replacement.match(
      /\bawait\s+executeHttpWriteJsonResponse\s*\(/g
    ) ?? [];

  if (calls.length !== 1) {
    return {
      eligible: false,
      reason:
        "Expected exactly one transformer-generated HTTP JSON helper call."
    };
  }

  const boundReplacement =
    replacement.replace(
      /\bawait\s+executeHttpWriteJsonResponse\s*\(/,
      `await ${HTTP_JSON_HELPER_ALIAS}(`
    );

  if (
    /\bexecuteHttpWriteJsonResponse\s*\(/.test(
      boundReplacement
    )
  ) {
    return {
      eligible: false,
      reason:
        "Generated HTTP JSON binding left an unbound helper call."
    };
  }

  return {
    eligible: true,
    importStatement:
      HTTP_JSON_HELPER_IMPORT,
    helperAlias:
      HTTP_JSON_HELPER_ALIAS,
    sourceWithImport:
      insertImport(source),
    boundReplacement
  };
}

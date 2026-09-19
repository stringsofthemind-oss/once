export const ONCE_CLIENT_ALIAS =
  "__OnceAgentClient" as const;

export const ONCE_IMPORT =
  'import { Once as __OnceAgentClient } from "@once-agent/sdk";' as const;

export type OnceBindingSuccess = {
  eligible: true;
  importStatement:
    typeof ONCE_IMPORT;
  clientAlias:
    typeof ONCE_CLIENT_ALIAS;
  sourceWithImport: string;
  boundReplacement: string;
  constructorTiming: "call-site";
};

export type OnceBindingFailure = {
  eligible: false;
  reason: string;
};

export type OnceBindingResult =
  | OnceBindingSuccess
  | OnceBindingFailure;

function hasEsmSyntax(
  source: string
): boolean {

  return (
    /(^|\n)\s*import\s+/m.test(
      source
    ) ||
    /(^|\n)\s*export\s+/m.test(
      source
    )
  );
}

function aliasExists(
  source: string
): boolean {

  return new RegExp(
    `\\b${ONCE_CLIENT_ALIAS}\\b`
  ).test(
    source
  );
}

function findImportInsertionOffset(
  source: string
): number {

  let cursor =
    source.charCodeAt(0) ===
    0xFEFF
      ? 1
      : 0;

  /*
   * Preserve a Node shebang.
   */
  if (
    source.startsWith(
      "#!",
      cursor
    )
  ) {

    const newline =
      source.indexOf(
        "\n",
        cursor
      );

    cursor =
      newline < 0
        ? source.length
        : newline + 1;
  }

  /*
   * Preserve the directive prologue:
   *
   * "use client";
   * "use strict";
   *
   * Comments and whitespace do not end a directive
   * prologue, so skip them while searching.
   */
  let search =
    cursor;

  let lastDirectiveEnd =
    cursor;

  while (
    search <
    source.length
  ) {

    const whitespace =
      source
        .slice(search)
        .match(
          /^[ \t\r\n]+/
        );

    if (whitespace) {
      search +=
        whitespace[0].length;
    }

    if (
      source.startsWith(
        "//",
        search
      )
    ) {

      const newline =
        source.indexOf(
          "\n",
          search
        );

      search =
        newline < 0
          ? source.length
          : newline + 1;

      continue;
    }

    if (
      source.startsWith(
        "/*",
        search
      )
    ) {

      const close =
        source.indexOf(
          "*/",
          search + 2
        );

      if (
        close < 0
      ) {
        return cursor;
      }

      search =
        close + 2;

      continue;
    }

    const directive =
      source
        .slice(search)
        .match(
          /^(["'])(?:\\.|(?!\1)[^\\\r\n])*\1\s*;?/
        );

    if (!directive) {
      break;
    }

    search +=
      directive[0].length;

    /*
     * Include the remainder of the directive line.
     */
    const newline =
      source.indexOf(
        "\n",
        search
      );

    lastDirectiveEnd =
      newline < 0
        ? source.length
        : newline + 1;

    search =
      lastDirectiveEnd;
  }

  return lastDirectiveEnd;
}

function insertOnceImport(
  source: string
): string {

  const offset =
    findImportInsertionOffset(
      source
    );

  const before =
    source.slice(
      0,
      offset
    );

  const after =
    source.slice(
      offset
    );

  const separatorBefore =
    before.length > 0 &&
    !before.endsWith("\n")
      ? "\n"
      : "";

  return (
    before +
    separatorBefore +
    ONCE_IMPORT +
    "\n" +
    after
  );
}

export function bindOnceCallSiteV1(
  source: string,
  replacement: string
): OnceBindingResult {

  if (
    !hasEsmSyntax(
      source
    )
  ) {
    return {
      eligible: false,
      reason:
        "v0.8 automatic binding supports ESM TypeScript modules only."
    };
  }

  if (
    aliasExists(
      source
    )
  ) {
    return {
      eligible: false,
      reason:
        `Reserved Once client alias ${ONCE_CLIENT_ALIAS} already exists in the source file.`
    };
  }

  const calls =
    replacement.match(
      /\bawait\s+once\.execute\s*\(/g
    ) ?? [];

  if (
    calls.length !== 1
  ) {
    return {
      eligible: false,
      reason:
        "Expected exactly one transformer-generated await once.execute(...) call."
    };
  }

  const boundReplacement =
    replacement.replace(
      /\bawait\s+once\.execute\s*\(/,
      `await new ${ONCE_CLIENT_ALIAS}().execute(`
    );

  if (
    /\bconst\s+once\b/.test(
      boundReplacement
    ) ||
    /\blet\s+once\b/.test(
      boundReplacement
    )
  ) {
    return {
      eligible: false,
      reason:
        "Generated binding unexpectedly introduced a persistent once variable."
    };
  }

  return {
    eligible: true,

    importStatement:
      ONCE_IMPORT,

    clientAlias:
      ONCE_CLIENT_ALIAS,

    sourceWithImport:
      insertOnceImport(
        source
      ),

    boundReplacement,

    constructorTiming:
      "call-site"
  };
}
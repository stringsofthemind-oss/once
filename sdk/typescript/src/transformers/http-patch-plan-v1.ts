import {
  createHash
} from "node:crypto";

import {
  transformHttpWriteV1
} from "./http-write-v1.js";

import {
  bindOnceCallSiteV1
} from "./once-binding-v1.js";

export const HTTP_WRITE_PATCH_PLAN_ID =
  "ts_fetch_post_void_patch_v1" as const;

export type HttpWritePatchInput = {
  source: string;
  statement: string;
  functionSource: string;
  provider: string;
};

export type HttpWritePatchSuccess = {
  eligible: true;

  patchPlan:
    typeof HTTP_WRITE_PATCH_PLAN_ID;

  transformerId:
    "ts_fetch_post_void_v1";

  bindingStrategy:
    "call-site-constructor";

  proposedSource: string;

  targetUrl: string;

  sourceSha256: string;

  proposedSourceSha256: string;
};

export type HttpWritePatchFailure = {
  eligible: false;
  reason: string;
};

export type HttpWritePatchResult =
  | HttpWritePatchSuccess
  | HttpWritePatchFailure;

function sha256(
  value: string
): string {

  return createHash(
    "sha256"
  )
    .update(
      value,
      "utf8"
    )
    .digest(
      "hex"
    );
}

function countExact(
  source: string,
  needle: string
): number {

  if (!needle) {
    return 0;
  }

  let count =
    0;

  let offset =
    0;

  while (true) {

    const index =
      source.indexOf(
        needle,
        offset
      );

    if (
      index < 0
    ) {
      break;
    }

    count++;

    offset =
      index +
      needle.length;
  }

  return count;
}

function indentReplacement(
  source: string,
  index: number,
  replacement: string
): string | null {

  const lineStart =
    source.lastIndexOf(
      "\n",
      Math.max(
        0,
        index - 1
      )
    ) + 1;

  const prefix =
    source.slice(
      lineStart,
      index
    );

  /*
   * We only replace a standalone statement.
   * Anything executable before it on the same
   * line is outside the proven patch model.
   */
  if (
    !/^[ \t]*$/.test(
      prefix
    )
  ) {
    return null;
  }

  return replacement
    .split("\n")
    .map(
      (line, lineIndex) =>
        lineIndex === 0
          ? line
          : prefix + line
    )
    .join("\n");
}

export function buildHttpWritePatchV1(
  input: HttpWritePatchInput
): HttpWritePatchResult {

  const source =
    input.source.replace(
      /\r\n/g,
      "\n"
    );

  const statement =
    input.statement
      .replace(
        /\r\n/g,
        "\n"
      )
      .trim();

  if (!statement) {
    return {
      eligible: false,
      reason:
        "The source statement is empty."
    };
  }

  const transformer =
    transformHttpWriteV1({
      statement,
      functionSource:
        input.functionSource,
      provider:
        input.provider
    });

  if (
    !transformer.eligible
  ) {
    return {
      eligible: false,
      reason:
        transformer.reason
    };
  }

  /*
   * Fail closed if the exact statement occurs
   * more than once. An automatic patch must
   * have one unambiguous target.
   */
  const originalOccurrences =
    countExact(
      source,
      statement
    );

  if (
    originalOccurrences !== 1
  ) {
    return {
      eligible: false,
      reason:
        `Expected exactly one exact source statement; found ${originalOccurrences}.`
    };
  }

  const binding =
    bindOnceCallSiteV1(
      source,
      transformer.replacement
    );

  if (
    !binding.eligible
  ) {
    return {
      eligible: false,
      reason:
        binding.reason
    };
  }

  const sourceWithImport =
    binding.sourceWithImport;

  const occurrencesAfterImport =
    countExact(
      sourceWithImport,
      statement
    );

  if (
    occurrencesAfterImport !== 1
  ) {
    return {
      eligible: false,
      reason:
        "Import insertion changed or duplicated the target statement."
    };
  }

  const index =
    sourceWithImport.indexOf(
      statement
    );

  if (
    index < 0
  ) {
    return {
      eligible: false,
      reason:
        "Exact source statement disappeared before replacement."
    };
  }

  const replacement =
    indentReplacement(
      sourceWithImport,
      index,
      binding.boundReplacement
    );

  if (!replacement) {
    return {
      eligible: false,
      reason:
        "Target statement is not isolated on its source line."
    };
  }

  const proposedSource =
    sourceWithImport.slice(
      0,
      index
    ) +
    replacement +
    sourceWithImport.slice(
      index +
      statement.length
    );

  if (
    countExact(
      proposedSource,
      statement
    ) !== 0
  ) {
    return {
      eligible: false,
      reason:
        "Original consequential statement remains after transformation."
    };
  }

  const importCount =
    countExact(
      proposedSource,
      binding.importStatement
    );

  if (
    importCount !== 1
  ) {
    return {
      eligible: false,
      reason:
        `Expected one Once SDK import; found ${importCount}.`
    };
  }

  const executionCount =
    (
      proposedSource.match(
        /\bnew\s+__OnceAgentClient\(\)\.execute\s*\(/g
      ) ?? []
    ).length;

  if (
    executionCount !== 1
  ) {
    return {
      eligible: false,
      reason:
        `Expected one bound Once execution; found ${executionCount}.`
    };
  }

  if (
    /\bawait\s+once\.execute\s*\(/.test(
      proposedSource
    )
  ) {
    return {
      eligible: false,
      reason:
        "Unbound transformer call remains in proposed source."
    };
  }

  return {
    eligible: true,

    patchPlan:
      HTTP_WRITE_PATCH_PLAN_ID,

    transformerId:
      transformer.transformer,

    bindingStrategy:
      "call-site-constructor",

    proposedSource,

    targetUrl:
      transformer.url,

    sourceSha256:
      sha256(source),

    proposedSourceSha256:
      sha256(
        proposedSource
      )
  };
}
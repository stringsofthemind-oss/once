import { createHash } from "node:crypto";

import {
  transformHttpResponseReturnV1
} from "./http-response-return-v1.js";

import {
  bindHttpResponseHelperV1
} from "./http-response-binding-v1.js";

export const HTTP_RESPONSE_RETURN_PATCH_PLAN_ID =
  "ts_fetch_response_return_patch_v1" as const;

export type HttpResponseReturnPatchInput = {
  source: string;
  statement: string;
  functionSource: string;
  provider: string;
  capability?: unknown;
};

export type HttpResponseReturnPatchSuccess = {
  eligible: true;
  patchPlan:
    typeof HTTP_RESPONSE_RETURN_PATCH_PLAN_ID;
  transformerId:
    "ts_fetch_response_return_v1";
  bindingStrategy:
    "http-response-helper-import";
  proposedSource: string;
  targetUrl: string;
  sourceSha256: string;
  proposedSourceSha256: string;
  capabilityFingerprint: string;
};

export type HttpResponseReturnPatchFailure = {
  eligible: false;
  reason: string;
};

export type HttpResponseReturnPatchResult =
  | HttpResponseReturnPatchSuccess
  | HttpResponseReturnPatchFailure;

function sha256(
  value: string
): string {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

function countExact(
  source: string,
  needle: string
): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let offset = 0;

  while (true) {
    const index =
      source.indexOf(needle, offset);

    if (index < 0) {
      break;
    }

    count++;
    offset = index + needle.length;
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
      Math.max(0, index - 1)
    ) + 1;

  const prefix =
    source.slice(lineStart, index);

  if (!/^[ \t]*$/.test(prefix)) {
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

export function buildHttpResponseReturnPatchV1(
  input: HttpResponseReturnPatchInput
): HttpResponseReturnPatchResult {
  const source =
    input.source.replace(/\r\n/g, "\n");

  const statement =
    input.statement
      .replace(/\r\n/g, "\n")
      .trim();

  if (!statement) {
    return {
      eligible: false,
      reason:
        "The source statement is empty."
    };
  }

  const transformer =
    transformHttpResponseReturnV1({
      statement,
      functionSource:
        input.functionSource,
      provider:
        input.provider,
      capability:
        input.capability
    });

  if (!transformer.eligible) {
    return {
      eligible: false,
      reason:
        transformer.reason
    };
  }

  const originalOccurrences =
    countExact(source, statement);

  if (originalOccurrences !== 1) {
    return {
      eligible: false,
      reason:
        `Expected exactly one exact source statement; found ${originalOccurrences}.`
    };
  }

  const binding =
    bindHttpResponseHelperV1(
      source,
      transformer.replacement
    );

  if (!binding.eligible) {
    return {
      eligible: false,
      reason:
        binding.reason
    };
  }

  const sourceWithImport =
    binding.sourceWithImport;

  if (
    countExact(
      sourceWithImport,
      statement
    ) !== 1
  ) {
    return {
      eligible: false,
      reason:
        "Native HTTP Response helper import insertion changed or duplicated the target return statement."
    };
  }

  const index =
    sourceWithImport.indexOf(statement);

  if (index < 0) {
    return {
      eligible: false,
      reason:
        "Target returned-response fetch disappeared after helper import insertion."
    };
  }

  const indented =
    indentReplacement(
      sourceWithImport,
      index,
      binding.boundReplacement
    );

  if (indented === null) {
    return {
      eligible: false,
      reason:
        "Automatic native HTTP Response return patching requires the target to be a standalone statement."
    };
  }

  const proposedSource =
    sourceWithImport.slice(0, index) +
    indented +
    sourceWithImport.slice(
      index + statement.length
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
        "Target returned-response fetch remained after patch generation."
    };
  }

  return {
    eligible: true,
    patchPlan:
      HTTP_RESPONSE_RETURN_PATCH_PLAN_ID,
    transformerId:
      transformer.transformer,
    bindingStrategy:
      "http-response-helper-import",
    proposedSource,
    targetUrl:
      transformer.url,
    sourceSha256:
      sha256(source),
    proposedSourceSha256:
      sha256(proposedSource),
    capabilityFingerprint:
      transformer.capabilityFingerprint
  };
}

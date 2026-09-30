import { createHash } from "node:crypto";

import {
  transformHttpJsonConsumptionV1
} from "./http-json-consumption-v1.js";

import {
  bindHttpJsonHelperV1
} from "./http-json-binding-v1.js";

export const HTTP_JSON_PATCH_PLAN_ID =
  "ts_fetch_json_consumption_patch_v1" as const;

export type HttpJsonPatchInput = {
  source: string;
  statement: string;
  functionSource: string;
  provider: string;
  capability?: unknown;
};

export type HttpJsonPatchSuccess = {
  eligible: true;
  patchPlan:
    typeof HTTP_JSON_PATCH_PLAN_ID;
  transformerId:
    "ts_fetch_json_consumption_v1";
  bindingStrategy:
    "http-json-helper-import";
  proposedSource: string;
  targetUrl: string;
  sourceSha256: string;
  proposedSourceSha256: string;
  capabilityFingerprint: string;
};

export type HttpJsonPatchFailure = {
  eligible: false;
  reason: string;
};

export type HttpJsonPatchResult =
  | HttpJsonPatchSuccess
  | HttpJsonPatchFailure;

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

export function buildHttpJsonPatchV1(
  input: HttpJsonPatchInput
): HttpJsonPatchResult {
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
    transformHttpJsonConsumptionV1({
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
    bindHttpJsonHelperV1(
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

  const occurrencesAfterImport =
    countExact(
      sourceWithImport,
      statement
    );

  if (occurrencesAfterImport !== 1) {
    return {
      eligible: false,
      reason:
        "HTTP JSON helper import insertion changed or duplicated the target statement."
    };
  }

  const index =
    sourceWithImport.indexOf(statement);

  if (index < 0) {
    return {
      eligible: false,
      reason:
        "Target statement disappeared after helper import insertion."
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
        "Automatic HTTP JSON patching requires the target to be a standalone statement."
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
        "Target response-consuming fetch remained after patch generation."
    };
  }

  return {
    eligible: true,
    patchPlan:
      HTTP_JSON_PATCH_PLAN_ID,
    transformerId:
      transformer.transformer,
    bindingStrategy:
      "http-json-helper-import",
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

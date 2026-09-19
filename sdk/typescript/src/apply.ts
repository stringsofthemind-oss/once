import {
  createHash
} from "node:crypto";

import {
  promises as fs
} from "node:fs";

import path from "node:path";

import {
  buildHttpWritePatchV1
} from "./transformers/http-patch-plan-v1.js";

type PlanCandidate = {
  callsite_ref: string;
  file: string;
  line: number;
  function_name: string | null;
  category: string;
  automation_status: string;
  auto_apply_eligible: boolean;
  transformer_id?: string;
  patch_plan_id?: string;
  source_sha256?: string;
  proposed_source_sha256?: string;
  target_url?: string;
};

type ProtectPlan = {
  schema_version: number;
  provider: string | null;
  candidates: PlanCandidate[];
};

type OnceConfig = {
  provider?: {
    name?: string;
  };
};

type CapabilityManifest = {
  schema_version: number;
  provider: string;
  capabilities?: Array<{
    category?: string;
    action_type?: string;
    allowed_urls?: string[];
  }>;
};

export type ApplyResult = {
  callsiteRef: string;
  file: string;
  backupPath: string;
  sourceSha256: string;
  appliedSha256: string;
};

function sha256(
  value: string
): string {

  return createHash(
    "sha256"
  )
    .update(
      value.replace(
        /\r\n/g,
        "\n"
      ),
      "utf8"
    )
    .digest(
      "hex"
    );
}

function escapeRegExp(
  value: string
): string {

  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function extractAwaitFetchStatement(
  source: string,
  findingLine: number
): {
  statement: string;
  startOffset: number;
} | null {

  const normalized =
    source.replace(
      /\r\n/g,
      "\n"
    );

  const lines =
    normalized.split(
      "\n"
    );

  const target =
    Math.max(
      0,
      Math.min(
        lines.length - 1,
        findingLine - 1
      )
    );

  let startLine =
    -1;

  for (
    let i = target;
    i >= Math.max(
      0,
      target - 12
    );
    i--
  ) {

    if (
      /\bawait\s+fetch\s*\(/.test(
        lines[i]
      )
    ) {
      startLine = i;
      break;
    }
  }

  if (
    startLine < 0
  ) {
    return null;
  }

  let lineOffset =
    0;

  for (
    let i = 0;
    i < startLine;
    i++
  ) {
    lineOffset +=
      lines[i].length + 1;
  }

  const fragment =
    normalized.slice(
      lineOffset
    );

  const awaitMatch =
    fragment.match(
      /\bawait\s+fetch\s*\(/
    );

  if (
    !awaitMatch ||
    awaitMatch.index === undefined
  ) {
    return null;
  }

  const statementStart =
    awaitMatch.index;

  const openParen =
    fragment.indexOf(
      "(",
      statementStart
    );

  if (
    openParen < 0
  ) {
    return null;
  }

  let depth =
    0;

  let quote:
    "'" | '"' | null =
      null;

  let escaped =
    false;

  let closeParen =
    -1;

  for (
    let i = openParen;
    i < fragment.length;
    i++
  ) {

    const char =
      fragment[i];

    if (quote) {

      if (escaped) {
        escaped = false;
        continue;
      }

      if (
        char === "\\"
      ) {
        escaped = true;
        continue;
      }

      if (
        char === quote
      ) {
        quote = null;
      }

      continue;
    }

    if (
      char === "`"
    ) {
      return null;
    }

    if (
      char === "'" ||
      char === '"'
    ) {
      quote = char;
      continue;
    }

    if (
      char === "("
    ) {
      depth++;
      continue;
    }

    if (
      char === ")"
    ) {

      depth--;

      if (
        depth === 0
      ) {
        closeParen = i;
        break;
      }
    }
  }

  if (
    closeParen < 0
  ) {
    return null;
  }

  let end =
    closeParen + 1;

  while (
    end < fragment.length &&
    /\s/.test(
      fragment[end]
    )
  ) {
    end++;
  }

  if (
    fragment[end] === ";"
  ) {
    end++;
  }

  return {
    statement:
      fragment
        .slice(
          statementStart,
          end
        )
        .trim(),

    startOffset:
      lineOffset +
      statementStart
  };
}

function extractFunctionSource(
  source: string,
  functionName: string,
  statementStart: number
): string | null {

  const normalized =
    source.replace(
      /\r\n/g,
      "\n"
    );

  const before =
    normalized.slice(
      0,
      statementStart
    );

  const pattern =
    new RegExp(
      String.raw`(?:export\s+)?(?:async\s+)?function\s+${escapeRegExp(
        functionName
      )}\s*\(`,
      "g"
    );

  let lastIndex =
    -1;

  for (
    const match
    of before.matchAll(
      pattern
    )
  ) {

    if (
      match.index !== undefined
    ) {
      lastIndex =
        match.index;
    }
  }

  if (
    lastIndex < 0
  ) {
    return null;
  }

  return normalized.slice(
    lastIndex,
    Math.min(
      normalized.length,
      statementStart + 1
    )
  );
}

async function readJson<T>(
  file: string
): Promise<T> {

  const raw =
    await fs.readFile(
      file,
      "utf8"
    );

  return JSON.parse(
    raw.replace(
      /^\uFEFF/,
      ""
    )
  ) as T;
}

async function verifyTypeScript(
  source: string,
  fileName: string
): Promise<void> {

  const ts =
    await import(
      "typescript"
    );

  const result =
    ts.transpileModule(
      source,
      {
        fileName,

        reportDiagnostics:
          true,

        compilerOptions: {
          target:
            ts.ScriptTarget.ES2022,

          module:
            ts.ModuleKind.ESNext
        }
      }
    );

  const errors =
    (
      result.diagnostics ??
      []
    ).filter(
      diagnostic =>
        diagnostic.category ===
        ts.DiagnosticCategory.Error
    );

  if (
    errors.length > 0
  ) {

    const message =
      errors
        .map(
          diagnostic =>
            ts.flattenDiagnosticMessageText(
              diagnostic.messageText,
              "\n"
            )
        )
        .join(
          "\n"
        );

    throw new Error(
      "TypeScript verification failed:\n" +
      message
    );
  }
}

export async function applyProtectionPlan(
  requestedPath: string
): Promise<ApplyResult> {

  const root =
    path.resolve(
      requestedPath
    );

  const onceDirectory =
    path.join(
      root,
      ".once"
    );

  const configPath =
    path.join(
      onceDirectory,
      "config.json"
    );

  try {
    await fs.access(
      configPath
    );
  } catch (error) {

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code ===
        "ENOENT"
    ) {
      throw new Error(
        "Once is not configured for this project.\n\n" +
        "Run:\n" +
        "  once setup .\n\n" +
        "Then retry:\n" +
        "  once protect . --apply"
      );
    }

    throw error;
  }

  const plan =
    await readJson<ProtectPlan>(
      path.join(
        onceDirectory,
        "protect-plan.json"
      )
    );

  const config =
    await readJson<OnceConfig>(
      path.join(
        onceDirectory,
        "config.json"
      )
    );

  const manifest =
    await readJson<CapabilityManifest>(
      path.join(
        onceDirectory,
        "provider-capabilities.json"
      )
    );

  const provider =
    config.provider?.name?.trim();

  if (!provider) {
    throw new Error(
      "Configured provider missing."
    );
  }

  if (
    plan.provider !== provider
  ) {
    throw new Error(
      "Protect plan provider no longer matches configuration."
    );
  }

  if (
    manifest.schema_version !== 1 ||
    manifest.provider !== provider
  ) {
    throw new Error(
      "Provider capability manifest no longer matches configuration."
    );
  }

  const capability =
    manifest.capabilities?.find(
      item =>
        item.category ===
          "HTTP_WRITE" &&
        item.action_type ===
          "http_write_v1"
    );

  if (!capability) {
    throw new Error(
      "Required http_write_v1 capability is no longer declared."
    );
  }

  const patchable =
    plan.candidates.filter(
      candidate =>
        candidate.automation_status ===
          "PATCHABLE" &&
        candidate.auto_apply_eligible ===
          true
    );

  if (
    patchable.length !== 1
  ) {
    throw new Error(
      `--apply requires exactly one PATCHABLE candidate; found ${patchable.length}.`
    );
  }

  const candidate =
    patchable[0];

  if (
    !candidate.target_url
  ) {
    throw new Error(
      "Protect plan does not contain a pinned target URL."
    );
  }

  if (
    !Array.isArray(
      capability.allowed_urls
    ) ||
    !capability.allowed_urls.includes(
      candidate.target_url
    )
  ) {
    throw new Error(
      "Required http_write_v1 capability no longer allows the planned target URL."
    );
  }

  if (
    candidate.category !==
      "HTTP_WRITE" ||
    candidate.transformer_id !==
      "ts_fetch_post_void_v1" ||
    candidate.patch_plan_id !==
      "ts_fetch_post_void_patch_v1"
  ) {
    throw new Error(
      "Candidate is outside the supported v1.0 apply contract."
    );
  }

  if (
    !candidate.function_name ||
    !candidate.source_sha256 ||
    !candidate.proposed_source_sha256
  ) {
    throw new Error(
      "Protect plan is missing required patch metadata."
    );
  }

  const sourcePath =
    path.resolve(
      root,
      candidate.file
    );

  const relative =
    path.relative(
      root,
      sourcePath
    );

  if (
    relative.startsWith(
      ".."
    ) ||
    path.isAbsolute(
      relative
    )
  ) {
    throw new Error(
      "Candidate source path escaped the project root."
    );
  }

  const originalSource =
    await fs.readFile(
      sourcePath,
      "utf8"
    );

  if (
    sha256(
      originalSource
    ) !==
    candidate.source_sha256
  ) {
    throw new Error(
      "Source changed after Protect planning. Refusing stale patch."
    );
  }

  const extracted =
    extractAwaitFetchStatement(
      originalSource,
      candidate.line
    );

  if (!extracted) {
    throw new Error(
      "Could not re-identify the exact protected operation."
    );
  }

  const functionSource =
    extractFunctionSource(
      originalSource,
      candidate.function_name,
      extracted.startOffset
    );

  if (!functionSource) {
    throw new Error(
      "Could not re-identify the surrounding function."
    );
  }

  const patch =
    buildHttpWritePatchV1({
      source:
        originalSource,

      statement:
        extracted.statement,

      functionSource,

      provider
    });

  if (!patch.eligible) {
    throw new Error(
      "Patch no longer satisfies transformer contract: " +
      patch.reason
    );
  }

  if (
    patch.targetUrl !==
    candidate.target_url
  ) {
    throw new Error(
      "Recomputed target URL differs from Protect plan."
    );
  }

  if (
    patch.proposedSourceSha256 !==
    candidate.proposed_source_sha256
  ) {
    throw new Error(
      "Recomputed proposed-source fingerprint differs from Protect plan."
    );
  }

  await verifyTypeScript(
    patch.proposedSource,
    sourcePath
  );

  const backupDirectory =
    path.join(
      onceDirectory,
      "backups",
      candidate.callsite_ref
    );

  await fs.mkdir(
    backupDirectory,
    {
      recursive: true
    }
  );

  const stamp =
    new Date()
      .toISOString()
      .replace(
        /[:.]/g,
        "-"
      );

  const backupPath =
    path.join(
      backupDirectory,
      `${stamp}-${path.basename(sourcePath)}.bak`
    );

  await fs.writeFile(
    backupPath,
    originalSource,
    "utf8"
  );

  const temporaryPath =
    path.join(
      path.dirname(
        sourcePath
      ),
      `.once-${process.pid}-${Date.now()}-${path.basename(sourcePath)}.tmp`
    );

  let replaced =
    false;

  try {

    await fs.writeFile(
      temporaryPath,
      patch.proposedSource,
      {
        encoding:
          "utf8",

        flag:
          "wx"
      }
    );

    await fs.rename(
      temporaryPath,
      sourcePath
    );

    replaced =
      true;

    const applied =
      await fs.readFile(
        sourcePath,
        "utf8"
      );

    if (
      sha256(
        applied
      ) !==
      patch.proposedSourceSha256
    ) {
      throw new Error(
        "Applied source fingerprint differs from planned source."
      );
    }

    await verifyTypeScript(
      applied,
      sourcePath
    );

    return {
      callsiteRef:
        candidate.callsite_ref,

      file:
        candidate.file,

      backupPath,

      sourceSha256:
        patch.sourceSha256,

      appliedSha256:
        patch.proposedSourceSha256
    };

  } catch (error) {

    await fs.rm(
      temporaryPath,
      {
        force:
          true
      }
    );

    if (replaced) {

      await fs.writeFile(
        sourcePath,
        originalSource,
        "utf8"
      );
    }

    throw error;
  }
}

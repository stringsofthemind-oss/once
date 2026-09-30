export type HttpNativeResponseSourceStatement = {
  kind: "assignment" | "return";
  statement: string;
  startOffset: number;
};

function lineStart(
  source: string,
  offset: number
): number {
  return (
    source.lastIndexOf(
      "\n",
      Math.max(0, offset - 1)
    ) + 1
  );
}

function contentStart(
  source: string,
  start: number,
  end: number
): number {
  let cursor = start;

  while (
    cursor < end &&
    /[ \t]/.test(source[cursor] ?? "")
  ) {
    cursor++;
  }

  return cursor;
}

function classifyPrefix(
  value: string
): "assignment" | "return" | null {
  const trimmed =
    value.trim();

  if (
    /^const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*$/.test(
      trimmed
    )
  ) {
    return "assignment";
  }

  if (trimmed === "return") {
    return "return";
  }

  return null;
}

export function extractHttpNativeResponseStatementV1(
  source: string,
  awaitFetchStartOffset: number,
  awaitFetchStatement: string
): HttpNativeResponseSourceStatement | null {
  const normalized =
    source.replace(/\r\n/g, "\n");

  const inner =
    awaitFetchStatement
      .replace(/\r\n/g, "\n")
      .trim();

  if (
    !/^await\s+fetch\s*\(/.test(inner)
  ) {
    return null;
  }

  const exactInnerStart =
    normalized.indexOf(
      inner,
      awaitFetchStartOffset
    );

  if (
    exactInnerStart !== awaitFetchStartOffset
  ) {
    return null;
  }

  const endOffset =
    exactInnerStart +
    inner.length;

  const currentLineStart =
    lineStart(
      normalized,
      exactInnerStart
    );

  const sameLinePrefix =
    normalized.slice(
      currentLineStart,
      exactInnerStart
    );

  const sameLineKind =
    classifyPrefix(
      sameLinePrefix
    );

  if (sameLineKind) {
    const startOffset =
      contentStart(
        normalized,
        currentLineStart,
        exactInnerStart
      );

    return {
      kind:
        sameLineKind,
      statement:
        normalized
          .slice(
            startOffset,
            endOffset
          )
          .trim(),
      startOffset
    };
  }

  if (sameLinePrefix.trim() !== "") {
    return null;
  }

  if (currentLineStart === 0) {
    return null;
  }

  const previousLineEnd =
    currentLineStart - 1;

  const previousLineStart =
    lineStart(
      normalized,
      previousLineEnd
    );

  const previousLine =
    normalized.slice(
      previousLineStart,
      previousLineEnd
    );

  const previousLineKind =
    classifyPrefix(
      previousLine
    );

  if (!previousLineKind) {
    return null;
  }

  const startOffset =
    contentStart(
      normalized,
      previousLineStart,
      previousLineEnd
    );

  return {
    kind:
      previousLineKind,
    statement:
      normalized
        .slice(
          startOffset,
          endOffset
        )
        .trim(),
    startOffset
  };
}

import { createHash } from "node:crypto";
import ts from "typescript";

export const LOCAL_FUNCTION_TRANSFORMER_V1 = "mjs_local_function_v1" as const;
export const LOCAL_FUNCTION_PATCH_V1 = "mjs_local_function_patch_v1" as const;

const PROTECT_ALIAS = "__OnceProtectLocal";
const ID_ALIAS = "__OnceAgentId";

export type LocalFunctionAnalysisV1 =
  | {
      eligible: true;
      transformer: typeof LOCAL_FUNCTION_TRANSFORMER_V1;
      functionName: string;
      inputFields: string[];
      receiver: string;
      method: string;
      initializerStart: number;
      initializerEnd: number;
      initializerSource: string;
    }
  | {
      eligible: false;
      reason: string;
    };

export type LocalFunctionPatchV1 =
  | {
      eligible: true;
      transformer: typeof LOCAL_FUNCTION_TRANSFORMER_V1;
      patchPlan: typeof LOCAL_FUNCTION_PATCH_V1;
      inputFields: string[];
      idField: string;
      idPrefix: string;
      bindingStrategy: "esm_import_protect_local_v1";
      sourceSha256: string;
      proposedSourceSha256: string;
      proposedSource: string;
    }
  | {
      eligible: false;
      reason: string;
    };

function sha256(value: string): string {
  return createHash("sha256")
    .update(value.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

function hasModifier(
  node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> },
  kind: ts.SyntaxKind,
): boolean {
  return Boolean(node.modifiers?.some(modifier => modifier.kind === kind));
}

function fail(reason: string): LocalFunctionAnalysisV1 {
  return { eligible: false, reason };
}

export function analyzeLocalFunctionV1(input: {
  source: string;
  fileName: string;
  functionName: string;
  findingLine: number;
}): LocalFunctionAnalysisV1 {
  const { source, fileName, functionName, findingLine } = input;

  if (!/\.mjs$/i.test(fileName)) {
    return fail("Local-function bridge v1 supports explicit ESM `.mjs` modules only.");
  }

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(functionName)) {
    return fail("Local-function bridge v1 requires a simple named top-level export.");
  }

  if (!Number.isSafeInteger(findingLine) || findingLine < 1) {
    return fail("Local-function bridge v1 requires a valid scanner line number.");
  }

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );

  const matches: Array<{
    statement: ts.VariableStatement;
    declaration: ts.VariableDeclaration;
    initializer: ts.ArrowFunction;
  }> = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) ||
        !hasModifier(statement, ts.SyntaxKind.ExportKeyword) ||
        statement.declarationList.declarations.length !== 1) {
      continue;
    }

    const declaration = statement.declarationList.declarations[0];
    if (!ts.isIdentifier(declaration.name) || declaration.name.text !== functionName) {
      continue;
    }

    const initializer = declaration.initializer;
    if (!initializer || !ts.isArrowFunction(initializer)) {
      continue;
    }

    matches.push({ statement, declaration, initializer });
  }

  if (matches.length !== 1) {
    return fail("Local-function bridge v1 requires exactly one matching top-level exported arrow function.");
  }

  const { statement, initializer } = matches[0];
  const statementStartLine = sourceFile.getLineAndCharacterOfPosition(
    statement.getStart(sourceFile),
  ).line + 1;
  const statementEndLine = sourceFile.getLineAndCharacterOfPosition(statement.end).line + 1;

  if (findingLine < statementStartLine || findingLine > statementEndLine) {
    return fail("Scanner line does not resolve to the selected exported local function.");
  }

  if (!hasModifier(initializer, ts.SyntaxKind.AsyncKeyword)) {
    return fail("Local-function bridge v1 requires an async arrow function.");
  }

  if (initializer.parameters.length !== 1) {
    return fail("Local-function bridge v1 requires exactly one function parameter.");
  }

  const parameter = initializer.parameters[0];
  if (parameter.dotDotDotToken || parameter.initializer || !ts.isObjectBindingPattern(parameter.name)) {
    return fail("Local-function bridge v1 requires one simple object-destructured parameter.");
  }

  const inputFields: string[] = [];
  for (const element of parameter.name.elements) {
    if (element.dotDotDotToken || element.propertyName || element.initializer || !ts.isIdentifier(element.name)) {
      return fail("Local-function bridge v1 rejects aliases, defaults, rest fields, and nested destructuring.");
    }
    inputFields.push(element.name.text);
  }

  if (inputFields.length === 0 || new Set(inputFields).size !== inputFields.length) {
    return fail("Local-function bridge v1 requires at least one unique destructured input field.");
  }

  if (ts.isBlock(initializer.body)) {
    return fail("Local-function bridge v1 requires an expression body containing exactly one direct effect call.");
  }

  if (!ts.isCallExpression(initializer.body)) {
    return fail("Local-function bridge v1 requires the expression body to be one direct call.");
  }

  const callee = initializer.body.expression;
  if (!ts.isPropertyAccessExpression(callee) ||
      ts.isPropertyAccessChain(callee) ||
      !ts.isIdentifier(callee.expression) ||
      !ts.isIdentifier(callee.name)) {
    return fail("Local-function bridge v1 requires a direct receiver.method(...) effect call.");
  }

  const receiver = callee.expression.text;
  if (inputFields.includes(receiver)) {
    return fail("Local-function bridge v1 does not allow the effect provider/receiver to arrive through the protected payload parameter.");
  }

  return {
    eligible: true,
    transformer: LOCAL_FUNCTION_TRANSFORMER_V1,
    functionName,
    inputFields,
    receiver,
    method: callee.name.text,
    initializerStart: initializer.getStart(sourceFile),
    initializerEnd: initializer.end,
    initializerSource: source.slice(initializer.getStart(sourceFile), initializer.end),
  };
}

function importInsertionOffset(source: string): number {
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;

  if (source.startsWith("#!", offset)) {
    const newline = source.indexOf("\n", offset);
    return newline < 0 ? source.length : newline + 1;
  }

  return offset;
}

function isSafeIdentityPrefix(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function buildLocalFunctionPatchV1(input: {
  source: string;
  fileName: string;
  functionName: string;
  findingLine: number;
  idField: string;
  idPrefix: string;
}): LocalFunctionPatchV1 {
  const analysis = analyzeLocalFunctionV1(input);
  if (!analysis.eligible) return analysis;

  const idField = input.idField.trim();
  const idPrefix = input.idPrefix;

  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(idField)) {
    return { eligible: false, reason: "Local-function bridge v1 requires an explicit simple identifier field for logical action identity." };
  }

  if (!analysis.inputFields.includes(idField)) {
    return { eligible: false, reason: `Explicit identity field ${idField} is not present in the selected function input.` };
  }

  if (!isSafeIdentityPrefix(idPrefix)) {
    return { eligible: false, reason: "Local-function bridge v1 requires an explicit nonempty literal identity prefix of at most 128 printable characters." };
  }

  const aliasPattern = new RegExp(`\\b(?:${PROTECT_ALIAS}|${ID_ALIAS})\\b`);
  if (aliasPattern.test(input.source)) {
    return { eligible: false, reason: "Generated Once local-protection binding would collide with an existing source identifier." };
  }

  const lineBreak = input.source.includes("\r\n") ? "\r\n" : "\n";
  const destructured = `{ ${analysis.inputFields.join(", ")} }`;
  const idDestructured = `{ ${idField} }`;
  const wrapped = [
    `${PROTECT_ALIAS}(`,
    `  ${analysis.initializerSource},`,
    "  {",
    `    id: (${idDestructured}) => ${ID_ALIAS}.id(${JSON.stringify(idPrefix)}, ${idField}),`,
    `    payload: (${destructured}) => (${destructured})`,
    "  }",
    ")",
  ].join(lineBreak);

  let proposed =
    input.source.slice(0, analysis.initializerStart) +
    wrapped +
    input.source.slice(analysis.initializerEnd);

  const importLine =
    `import { Once as ${ID_ALIAS}, protectLocal as ${PROTECT_ALIAS} } from "@once-agent/sdk";${lineBreak}`;
  const insertion = importInsertionOffset(proposed);
  proposed = proposed.slice(0, insertion) + importLine + proposed.slice(insertion);

  if (proposed === input.source) {
    return { eligible: false, reason: "Local-function bridge v1 produced no source change." };
  }

  return {
    eligible: true,
    transformer: LOCAL_FUNCTION_TRANSFORMER_V1,
    patchPlan: LOCAL_FUNCTION_PATCH_V1,
    inputFields: [...analysis.inputFields],
    idField,
    idPrefix,
    bindingStrategy: "esm_import_protect_local_v1",
    sourceSha256: sha256(input.source),
    proposedSourceSha256: sha256(proposed),
    proposedSource: proposed,
  };
}

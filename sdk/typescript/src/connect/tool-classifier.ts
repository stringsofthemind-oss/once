export const CONNECT_TOOL_DECISION = Object.freeze({
  PROTECT: "PROTECT",
  BYPASS: "BYPASS",
  UNKNOWN: "UNKNOWN",
} as const);

export type ConnectToolDecision =
  (typeof CONNECT_TOOL_DECISION)[keyof typeof CONNECT_TOOL_DECISION];

export interface ConnectToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface ConnectToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: ConnectToolAnnotations;
  _meta?: Record<string, unknown>;
}

export type ConnectToolClassificationReason =
  | "INVALID_TOOL_DESCRIPTOR"
  | "INVALID_TOOL_ANNOTATIONS"
  | "EXPLICIT_READ_ONLY"
  | "EXPLICIT_IDEMPOTENT_WRITE"
  | "EXPLICIT_WRITE"
  | "MUTATION_SIGNAL"
  | "READ_ONLY_SIGNAL"
  | "CONFLICTING_SIGNALS"
  | "INSUFFICIENT_EVIDENCE";

export interface ConnectToolClassification {
  decision: ConnectToolDecision;
  reason: ConnectToolClassificationReason;
  signals: readonly string[];
}

/*
 * Keep this list action-oriented. Object nouns such as email, message,
 * order, and post are intentionally excluded so names like search_messages
 * and list_orders do not look mutating merely because of their subject.
 */
const MUTATION_NAME_TOKENS = new Set([
  "activate",
  "add",
  "approve",
  "archive",
  "assign",
  "book",
  "buy",
  "cancel",
  "charge",
  "close",
  "comment",
  "commit",
  "create",
  "deactivate",
  "delete",
  "deploy",
  "disable",
  "edit",
  "enable",
  "execute",
  "follow",
  "grant",
  "invite",
  "lock",
  "mark",
  "merge",
  "modify",
  "move",
  "pay",
  "place",
  "provision",
  "publish",
  "purchase",
  "refund",
  "reject",
  "remove",
  "rename",
  "reserve",
  "reschedule",
  "restart",
  "restore",
  "revoke",
  "save",
  "schedule",
  "send",
  "set",
  "share",
  "sign",
  "start",
  "stop",
  "submit",
  "subscribe",
  "transfer",
  "unlock",
  "unfollow",
  "unsubscribe",
  "unschedule",
  "update",
  "upload",
  "write",
]);

const READ_ONLY_NAME_TOKENS = new Set([
  "analyze",
  "calculate",
  "check",
  "compute",
  "convert",
  "describe",
  "fetch",
  "find",
  "format",
  "generate",
  "get",
  "history",
  "inspect",
  "list",
  "lookup",
  "metrics",
  "parse",
  "preview",
  "read",
  "render",
  "retrieve",
  "search",
  "show",
  "stats",
  "status",
  "summarize",
  "translate",
  "validate",
  "view",
]);

const MUTATION_DESCRIPTION_PATTERNS = [
  /\b(activates?|adds?|approves?|archives?|assigns?)\b/i,
  /\b(books?|buys?|cancels?|charges?|closes?|commits?|creates?)\b/i,
  /\b(deactivates?|deletes?|deploys?|disables?|edits?|enables?)\b/i,
  /\b(follows?|grants?|invites?|locks?|marks?|merges?|modifies?|moves?)\b/i,
  /\b(pays?|places?|provisions?|publishes?|purchases?|refunds?)\b/i,
  /\b(rejects?|removes?|renames?|reserves?|reschedules?|restarts?)\b/i,
  /\b(restores?|revokes?|saves?|schedules?|sends?|sets?|shares?|signs?)\b/i,
  /\b(starts?|stops?|submits?|subscribes?|transfers?|unlocks?)\b/i,
  /\b(unfollows?|unsubscribes?|unschedules?|updates?|uploads?|writes?)\b/i,
  /\b(changes? external state|modifies? external state|side[- ]effecting)\b/i,
];

const READ_ONLY_DESCRIPTION_PATTERNS = [
  /\bread[- ]only\b/i,
  /\bno side effects?\b/i,
  /\bdoes not (?:modify|change|write|mutate)\b/i,
  /\bwithout (?:modifying|changing|writing|mutating|saving)\b/i,
  /\b(searches?|reads?|retrieves?|fetches?|lists?|looks? up|inspects?)\b/i,
  /\b(generates?|summarizes?|translates?|analyzes?|calculates?|computes?)\b/i,
  /\b(converts?|formats?|parses?|renders?|validates?)\b/i,
];

function freezeResult(
  decision: ConnectToolDecision,
  reason: ConnectToolClassificationReason,
  signals: string[],
): Readonly<ConnectToolClassification> {
  return Object.freeze({
    decision,
    reason,
    signals: Object.freeze([...signals]),
  });
}

function normalizeName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function hasPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function validateAnnotations(
  value: unknown,
): value is ConnectToolAnnotations | undefined {
  if (value === undefined) {
    return true;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ]) {
    if (
      candidate[key] !== undefined &&
      typeof candidate[key] !== "boolean"
    ) {
      return false;
    }
  }

  if (
    candidate.title !== undefined &&
    typeof candidate.title !== "string"
  ) {
    return false;
  }

  return true;
}

/**
 * Infer whether a tool should cross the Once Connect safety boundary.
 *
 * This is intentionally conservative. Explicit metadata and deterministic
 * name/description semantics cross-check one another. Weak or contradictory
 * evidence resolves to UNKNOWN rather than permission.
 *
 * UNKNOWN is not a bypass decision. Callers should require an explicit safety
 * declaration, human/config policy, or another trusted classifier before
 * executing a consequential operation outside Once.
 */
export function classifyConnectTool(
  tool: unknown,
): Readonly<ConnectToolClassification> {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return freezeResult(
      CONNECT_TOOL_DECISION.UNKNOWN,
      "INVALID_TOOL_DESCRIPTOR",
      [],
    );
  }

  const candidate = tool as Record<string, unknown>;

  if (
    typeof candidate.name !== "string" ||
    candidate.name.trim().length === 0
  ) {
    return freezeResult(
      CONNECT_TOOL_DECISION.UNKNOWN,
      "INVALID_TOOL_DESCRIPTOR",
      [],
    );
  }

  if (
    candidate.description !== undefined &&
    typeof candidate.description !== "string"
  ) {
    return freezeResult(
      CONNECT_TOOL_DECISION.UNKNOWN,
      "INVALID_TOOL_DESCRIPTOR",
      [],
    );
  }

  if (!validateAnnotations(candidate.annotations)) {
    return freezeResult(
      CONNECT_TOOL_DECISION.UNKNOWN,
      "INVALID_TOOL_ANNOTATIONS",
      [],
    );
  }

  const annotations = candidate.annotations as
    | ConnectToolAnnotations
    | undefined;

  const nameTokens = normalizeName(candidate.name);
  const description =
    typeof candidate.description === "string"
      ? candidate.description
      : "";

  const mutationNameTokens = nameTokens.filter(token =>
    MUTATION_NAME_TOKENS.has(token),
  );

  const readOnlyNameTokens = nameTokens.filter(token =>
    READ_ONLY_NAME_TOKENS.has(token),
  );

  const mutationDescription =
    hasPattern(description, MUTATION_DESCRIPTION_PATTERNS);

  const readOnlyDescription =
    hasPattern(description, READ_ONLY_DESCRIPTION_PATTERNS);

  const mutationSignal =
    mutationNameTokens.length > 0 || mutationDescription;

  const readOnlySignal =
    readOnlyNameTokens.length > 0 || readOnlyDescription;

  const signals: string[] = [];

  for (const token of mutationNameTokens) {
    signals.push(`name:${token}`);
  }

  for (const token of readOnlyNameTokens) {
    signals.push(`name:${token}`);
  }

  if (mutationDescription) {
    signals.push("description:mutation");
  }

  if (readOnlyDescription) {
    signals.push("description:read-only");
  }

  if (mutationSignal && readOnlySignal) {
    return freezeResult(
      CONNECT_TOOL_DECISION.UNKNOWN,
      "CONFLICTING_SIGNALS",
      signals,
    );
  }

  if (annotations?.readOnlyHint === true) {
    signals.push("annotations.readOnlyHint=true");

    if (
      annotations.destructiveHint === true ||
      mutationSignal
    ) {
      if (annotations.destructiveHint === true) {
        signals.push("annotations.destructiveHint=true");
      }

      return freezeResult(
        CONNECT_TOOL_DECISION.UNKNOWN,
        "CONFLICTING_SIGNALS",
        signals,
      );
    }

    return freezeResult(
      CONNECT_TOOL_DECISION.BYPASS,
      "EXPLICIT_READ_ONLY",
      signals,
    );
  }

  if (annotations?.readOnlyHint === false) {
    signals.push("annotations.readOnlyHint=false");

    if (readOnlySignal && !mutationSignal) {
      return freezeResult(
        CONNECT_TOOL_DECISION.UNKNOWN,
        "CONFLICTING_SIGNALS",
        signals,
      );
    }

    if (annotations.idempotentHint === true) {
      signals.push("annotations.idempotentHint=true");

      return freezeResult(
        CONNECT_TOOL_DECISION.BYPASS,
        "EXPLICIT_IDEMPOTENT_WRITE",
        signals,
      );
    }

    if (annotations.idempotentHint === false) {
      signals.push("annotations.idempotentHint=false");
    }

    if (annotations.destructiveHint !== undefined) {
      signals.push(
        `annotations.destructiveHint=${String(annotations.destructiveHint)}`,
      );
    }

    return freezeResult(
      CONNECT_TOOL_DECISION.PROTECT,
      "EXPLICIT_WRITE",
      signals,
    );
  }

  if (annotations?.idempotentHint === true) {
    signals.push("annotations.idempotentHint=true");

    return freezeResult(
      CONNECT_TOOL_DECISION.BYPASS,
      "EXPLICIT_IDEMPOTENT_WRITE",
      signals,
    );
  }

  if (annotations?.destructiveHint === true) {
    signals.push("annotations.destructiveHint=true");

    if (readOnlySignal) {
      return freezeResult(
        CONNECT_TOOL_DECISION.UNKNOWN,
        "CONFLICTING_SIGNALS",
        signals,
      );
    }

    return freezeResult(
      CONNECT_TOOL_DECISION.PROTECT,
      "EXPLICIT_WRITE",
      signals,
    );
  }

  if (mutationSignal) {
    return freezeResult(
      CONNECT_TOOL_DECISION.PROTECT,
      "MUTATION_SIGNAL",
      signals,
    );
  }

  if (readOnlySignal) {
    return freezeResult(
      CONNECT_TOOL_DECISION.BYPASS,
      "READ_ONLY_SIGNAL",
      signals,
    );
  }

  return freezeResult(
    CONNECT_TOOL_DECISION.UNKNOWN,
    "INSUFFICIENT_EVIDENCE",
    signals,
  );
}

export function classifyConnectTools(
  tools: readonly unknown[],
): readonly Readonly<ConnectToolClassification>[] {
  return Object.freeze(tools.map(tool => classifyConnectTool(tool)));
}

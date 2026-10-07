import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { canonicalizeConnectPayload, LocalProtectionError, protectToolCall } from "@once-agent/sdk";
import { withLocalProtectionSession } from "@once-agent/sdk/connect";
import { openExistingLedger } from "./existing-ledger.js";

const origin = "https://api.github.com";
const name = "once_create_github_issue";
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const safeText = (max: number) => z.string().max(max).refine(x => !/once-correlation:|github_pat_|gh[pousr]_|Authorization\s*:|Bearer\s|@/i.test(x), "Reserved metadata, mentions and credential-bearing text are unsupported.");
const inputSchema = z.strictObject({ taskRef: identifier, title: safeText(256).min(1), body: safeText(8000) });
const authoritySchema = z.strictObject({ userId: z.number().int().positive(), ownerId: z.number().int().positive(), repositoryId: z.number().int().positive(), owner: identifier, repo: identifier });
export type GitHubAuthority = z.infer<typeof authoritySchema>;
type Input = z.infer<typeof inputSchema>;
type Effect = { contract: string; action: string; provider: "github"; apiOrigin: string; apiVersion: string; authority: GitHubAuthority; taskRef: string; title: string; body: string; providerBody: string };
type Issue = { id: number; number: number; title: string; body: string; repository_url: string; user: { id: number }; html_url: string };
const issueSchema = z.object({ id: z.number().int().positive(), number: z.number().int().positive(), title: z.string(), body: z.string(), repository_url: z.string(), user: z.object({ id: z.number().int().positive() }), html_url: z.string() });
const digest = (value: object) => createHash("sha256").update(canonicalizeConnectPayload(value as Record<string, unknown>)).digest("hex");

/** Host-owned direct REST client. The optional transport exists for local tests;
 * neither it, credentials, URLs, identity nor fault controls are tool inputs. */
export class GitHubIssueClient {
  readonly authority: GitHubAuthority;
  readonly #token: string;
  readonly #request: typeof fetch;
  readonly #afterCommit?: () => Promise<void>;
  readonly #lookupAllowed: () => boolean;
  constructor(options: { authority: GitHubAuthority; token: string; request?: typeof fetch; afterCommit?: () => Promise<void>; lookupAllowed?: () => boolean }) {
    this.authority = Object.freeze(authoritySchema.parse(options.authority));
    if (!options.token || /[\r\n]/.test(options.token)) throw Error("A host credential is required.");
    this.#token = options.token; this.#request = options.request ?? fetch;
    this.#afterCommit = options.afterCommit; this.#lookupAllowed = options.lookupAllowed ?? (() => true);
    Object.freeze(this);
  }
  get repositoryPath() { return `/repos/${this.authority.owner}/${this.authority.repo}`; }
  async #get(path: string, method = "GET", body?: object, pagination?: { next: boolean }): Promise<unknown> {
    const response = await this.#request(origin + path, {
      method, redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${this.#token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "Cache-Control": "no-cache", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status !== (method === "POST" ? 201 : 200)) throw Error("Provider unavailable.");
    const date = Date.parse(response.headers.get("date") ?? "");
    const age = Number(response.headers.get("age") ?? "0");
    if (!Number.isFinite(date) || date > Date.now() || Date.now() - date > 30_000 || age !== 0) throw Error("Stale provider evidence.");
    if (pagination) {
      const link = response.headers.get("link") ?? "";
      const next = link.split(",").find(x => /rel="next"/.test(x));
      pagination.next = Boolean(next);
      if (next) {
        const target = /<([^>]+)>/.exec(next)?.[1];
        const current = new URL(origin + path);
        const expected = Number(current.searchParams.get("page")) + 1;
        if (!target) throw Error("Incomplete pagination evidence.");
        const parsed = new URL(target);
        if (parsed.origin !== origin || parsed.pathname !== current.pathname || Number(parsed.searchParams.get("page")) !== expected) throw Error("Unsupported pagination boundary.");
      }
    }
    return response.json();
  }
  async assertAuthority() {
    const user = z.object({ id: z.number() }).parse(await this.#get("/user"));
    const repo = z.object({ id: z.number(), private: z.literal(true), has_issues: z.literal(true), owner: z.object({ id: z.number(), type: z.literal("User") }) }).parse(await this.#get(this.repositoryPath));
    if (user.id !== this.authority.userId || repo.id !== this.authority.repositoryId || repo.owner.id !== this.authority.ownerId || user.id !== repo.owner.id) throw new LocalProtectionError("UNSUPPORTED_BOUNDARY", "Provider authority does not match the configured private personal repository.");
  }
  #validate(raw: unknown, effect: Effect): Issue {
    const issue = issueSchema.parse(raw);
    if (raw && typeof raw === "object" && "pull_request" in raw) throw Error("Not an issue.");
    if (issue.repository_url !== origin + this.repositoryPath || issue.user.id !== this.authority.userId || issue.title !== effect.title || issue.body !== effect.providerBody || issue.html_url !== `https://github.com/${this.authority.owner}/${this.authority.repo}/issues/${issue.number}`) throw Error("Issue effect mismatch.");
    return issue;
  }
  async create(effect: Effect, operationId: string) {
    await this.assertAuthority();
    const raw = await this.#get(this.repositoryPath + "/issues", "POST", { title: effect.title, body: effect.providerBody });
    // Deliberately after provider commit but before a receipt is given to Once.
    await this.#afterCommit?.();
    await this.assertAuthority();
    return this.#receipt(this.#validate(raw, effect), effect, operationId);
  }
  #receipt(issue: Issue, effect: Effect, operationId: string) {
    return { operationId, effect, providerReference: String(issue.id), issueNumber: issue.number, url: issue.html_url };
  }
  async lookup(effect: Effect, operationId: string) {
    if (!this.#lookupAllowed()) return { status: "UNKNOWN" as const };
    try {
      const started = Date.now();
      await this.assertAuthority();
      const prefix = `<!-- once-correlation:${operationId}:`;
      const matches: unknown[] = [];
      let complete = false;
      for (let page = 1; page <= 100; page++) {
        const pagination = { next: false };
        const entries = z.array(z.object({ body: z.string().nullable(), number: z.number().int().positive() }).passthrough()).parse(await this.#get(`${this.repositoryPath}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`, "GET", undefined, pagination));
        matches.push(...entries.filter(x => !("pull_request" in x) && x.body?.includes(prefix)));
        if (!pagination.next && entries.length < 100) { complete = true; break; }
      }
      if (!complete || matches.length !== 1) return { status: "UNKNOWN" as const };
      const number = (matches[0] as { number: number }).number;
      const issue = this.#validate(await this.#get(`${this.repositoryPath}/issues/${number}`), effect);
      await this.assertAuthority();
      if (Date.now() - started > 30_000) return { status: "UNKNOWN" as const };
      return { status: "CONFIRMED" as const, result: this.#receipt(issue, effect, operationId) };
    } catch { return { status: "UNKNOWN" as const }; }
  }
}

export async function registerProtectedGitHubIssue(server: McpServer, options: {
  statePath: string; intents: Readonly<Record<string, string>>; provider: GitHubIssueClient; authorize(context: unknown): Promise<void>;
}) {
  if (!(options.provider instanceof GitHubIssueClient) || typeof options.authorize !== "function") throw new LocalProtectionError("UNSUPPORTED_BOUNDARY", "A fixed trusted capability and admission check are required.");
  const intents = Object.freeze(z.record(identifier, identifier).parse(options.intents));
  if (!Object.keys(intents).length || new Set(Object.values(intents)).size !== Object.keys(intents).length) throw Error("Distinct host-owned intents require distinct operation IDs.");
  const provider = options.provider;
  const authorize = options.authorize;
  const statePath = options.statePath;
  const ledger = await openExistingLedger(statePath);
  try { await provider.assertAuthority(); } catch { ledger.close(); throw new LocalProtectionError("UNSUPPORTED_BOUNDARY", "Cannot verify configured provider authority."); }
  const prepare = (input: Input, operationId: string): Effect => {
    const core = { contract: "once-github-issue-v1", action: name, provider: "github" as const, apiOrigin: origin, apiVersion: "2026-03-10", authority: provider.authority, ...input };
    return Object.freeze({ ...core, providerBody: `${input.body}\n\n<!-- once-correlation:${operationId}:${digest(core)} -->` });
  };
  try {
    server.registerTool("once_github_issue_context", {
      description: "Read the configured GitHub issue capability and host-provisioned task references. No provider mutation or intent allocation.",
      inputSchema: z.strictObject({}), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async (_input, context) => {
      await authorize(context); ledger.assertValid(); await provider.assertAuthority();
      const out = { action: name, repository: `${provider.authority.owner}/${provider.authority.repo}`, taskRefs: Object.keys(intents) };
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    });
    server.registerTool(name, {
      description: "Create one issue in the configured private repository. Use the same host-provisioned taskRef for retries and handoffs; changed title/body conflicts. UNKNOWN blocks retries until authoritative read-only recovery. No raw GitHub operations are supported.",
      inputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (input, context) => {
      try {
        ledger.assertValid(); await authorize(context); await provider.assertAuthority();
        if (!Object.hasOwn(intents, input.taskRef)) throw new LocalProtectionError("UNSUPPORTED_BOUNDARY", "Intent was not provisioned by the host.");
        const operationId = intents[input.taskRef];
        const effect = prepare(input, operationId);
        const result = await withLocalProtectionSession(ledger.session, () => protectToolCall({
          operationId, statePath, effect: { tool: name, args: effect },
          execute: async ({ args }) => { ledger.assertValid(); return provider.create(args, operationId); },
          reconcile: async ({ effect: saved }) => { ledger.assertValid(); return provider.lookup(saved.args, operationId); },
        }));
        const out = { taskRef: input.taskRef, status: "CONFIRMED", result };
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      } catch (error) {
        const code = error instanceof LocalProtectionError ? error.code : "UNSUPPORTED_BOUNDARY";
        const out = { taskRef: input.taskRef, status: code, retryAllowed: false };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      }
    });
  } catch (error) { ledger.close(); throw error; }
  return { close: () => ledger.close() };
}

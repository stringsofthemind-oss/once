import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { GitHubIssueClient, registerProtectedGitHubIssue } from "./github-issue.js";

const absolute = z.string().refine(isAbsolute);
const configSchema = z.strictObject({
  statePath: absolute, tokenPath: absolute,
  authority: z.strictObject({ userId: z.number().int().positive(), ownerId: z.number().int().positive(), repositoryId: z.number().int().positive(), owner: z.string(), repo: z.string() }),
  intents: z.record(z.string(), z.string()),
  // Operator-controlled canary only; absent in normal operation.
  faultControlPath: absolute.optional(),
});
const controlsSchema = z.strictObject({ loseNextAcknowledgement: z.boolean(), lookupEnabled: z.boolean() });
try {
  const configPath = process.env.ONCE_GITHUB_CONFIG;
  if (!configPath || !isAbsolute(configPath)) throw Error("configuration unavailable");
  const config = configSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const marker = packageRoot.indexOf(`${sep}runtime${sep}node_modules${sep}`);
  const pluginRoot = marker >= 0 ? packageRoot.slice(0, marker) : resolve(packageRoot, "../plugins");
  for (const protectedPath of [config.tokenPath, config.statePath, configPath, ...(config.faultControlPath ? [config.faultControlPath] : [])]) {
    const actual = realpathSync(protectedPath).toLowerCase();
    if ([packageRoot, pluginRoot].some(root => actual === root.toLowerCase() || actual.startsWith(root.toLowerCase() + sep)) || /[\\/]\.codex[\\/]plugins[\\/]cache[\\/]/i.test(actual)) throw Error("Persistent configuration, secrets and ledger must remain outside plugin source/cache.");
  }
  const token = readFileSync(config.tokenPath, "utf8").trim();
  const controls = () => controlsSchema.parse(JSON.parse(readFileSync(config.faultControlPath!, "utf8")));
  const provider = new GitHubIssueClient({
    authority: config.authority, token,
    lookupAllowed: () => !config.faultControlPath || controls().lookupEnabled,
    afterCommit: async () => {
      if (!config.faultControlPath) return;
      const current = controls();
      if (current.loseNextAcknowledgement) {
        writeFileSync(config.faultControlPath, JSON.stringify({ ...current, loseNextAcknowledgement: false }), { flush: true });
        throw Error("canary acknowledgement withheld");
      }
    },
  });
  const server = new McpServer({ name: "once-private-github-issue", version: "0.1.0-local" });
  const registration = await registerProtectedGitHubIssue(server, {
    statePath: config.statePath, intents: config.intents, provider,
    // Private stdio process is available only to its owning desktop task.
    authorize: async () => {},
  });
  process.on("exit", () => registration.close());
  serveStdio(() => server);
} catch {
  process.stderr.write("Once GitHub host cannot start: restore the configured valid ledger and verify private host configuration/authority.\n");
  process.exitCode = 1;
}

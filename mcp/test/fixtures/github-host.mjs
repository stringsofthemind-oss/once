import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { GitHubIssueClient, registerProtectedGitHubIssue } from '@once-agent/mcp/dist/github-issue.js';
const config = JSON.parse(process.env.ONCE_GITHUB_FIXTURE);
const provider = new GitHubIssueClient({ authority: config.authority, token: 'fixture-only-token', request: (url, init) => fetch(String(url).replace('https://api.github.com', config.fixtureUrl), init) });
const server = new McpServer({ name: 'github-fixture-host', version: '1' });
const registration = await registerProtectedGitHubIssue(server, { provider, statePath: config.statePath, intents: config.intents, authorize: async () => {} });
process.on('exit', () => registration.close());
serveStdio(() => server);

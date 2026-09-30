import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connectLocalAgentToolAuto } from '@once-agent/sdk/connect';

// A repository-specific example, not a general-purpose GitHub truth adapter.
export function createGithubIssueTool({ token, repository, actor, statePath,
  fetchImpl = fetch, maxPages = 10, simulateLostAck = false }) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') ||
      !/^[\w[\]-]+$/.test(actor ?? '') || !statePath ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new Error('Supply token, owner/repo, expected creator login, durable statePath, and maxPages (1–100).');
  }
  const base = `/repos/${repository}/issues`;
  async function request(path, method = 'GET', body) {
    // Fixed origin, no redirects and no automatic POST retries.
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status !== (method === 'POST' ? 201 : 200)) {
      throw new Error(`GitHub ${method} returned HTTP ${response.status}; outcome not inferred.`);
    }
    return response.json();
  }
  function effect(input) {
    if (typeof input.intent !== 'string' || !input.intent.trim() ||
        typeof input.title !== 'string' || !input.title.trim() || typeof input.body !== 'string') {
      throw new Error('Persist a nonempty intent and title plus a string body before calling.');
    }
    const key = createHash('sha256').update(JSON.stringify([
      repository, actor, input.intent, input.title, input.body,
    ])).digest('hex');
    return { repository, actor, title: input.title,
      body: `${input.body}\n\n<!-- once-github-intent:${key} -->` };
  }
  function matches(issue, expected) {
    return issue && !issue.pull_request && Number.isSafeInteger(issue.number) && issue.number > 0 &&
      issue.user?.login === expected.actor && issue.title === expected.title && issue.body === expected.body &&
      issue.html_url === `https://github.com/${expected.repository}/issues/${issue.number}`;
  }
  function receipt(issue) {
    return { issue_number: issue.number, url: issue.html_url, title: issue.title, body: issue.body };
  }
  return connectLocalAgentToolAuto({
    async execute(input) {
      const expected = effect(input);
      const issue = await request(base, 'POST', { title: expected.title, body: expected.body });
      if (simulateLostAck) throw new Error('Injected acknowledgement loss after GitHub accepted the issue.');
      if (!matches(issue, expected)) throw new Error('GitHub receipt did not match the bound effect.');
      return receipt(issue);
    },
  }, {
    descriptor: { name: 'create_github_issue', description: 'Create a GitHub issue, changing external state.' },
    id: input => JSON.stringify([repository, actor, input.intent]),
    payload: effect,
    statePath,
    async reconcile({ payload }) {
      const expected = payload.effect; // Connect includes {tool, effect}.
      // Check configuration too: never reconcile another repository/account's row.
      if (expected.repository !== repository || expected.actor !== actor) return { state: 'UNKNOWN' };
      const candidates = new Map();
      for (let page = 1; page <= maxPages; page++) {
        const issues = await request(`${base}?state=all&sort=created&direction=desc&per_page=100&page=${page}`);
        if (!Array.isArray(issues)) return { state: 'UNKNOWN' };
        for (const issue of issues) if (matches(issue, expected)) candidates.set(issue.number, issue);
        if (candidates.size > 1) return { state: 'UNKNOWN' };
        if (issues.length < 100) {
          if (candidates.size !== 1) return { state: 'UNKNOWN' }; // Never infer ABSENT.
          const number = candidates.keys().next().value;
          const current = await request(`${base}/${number}`);
          return matches(current, expected)
            ? { state: 'CONFIRMED', result: receipt(current) } : { state: 'UNKNOWN' };
        }
      }
      return { state: 'UNKNOWN' }; // Bounded/incomplete lookup is not provider truth.
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [inputPath, fault] = process.argv.slice(2);
    if (!inputPath || (fault && fault !== '--lose-ack')) throw new Error('Usage: node github-issue-recovery.mjs intent.json [--lose-ack]');
    const input = JSON.parse(readFileSync(inputPath, 'utf8'));
    const tool = createGithubIssueTool({ token: process.env.GITHUB_TOKEN,
      repository: process.env.GITHUB_REPOSITORY, actor: process.env.GITHUB_ACTOR,
      statePath: process.env.ONCE_STATE_PATH, simulateLostAck: fault === '--lose-ack' });
    console.log(JSON.stringify(await tool.execute(input), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ code: error.code ?? 'SETUP_OR_PROVIDER_ERROR', message: error.message }));
    process.exitCode = 1;
  }
}

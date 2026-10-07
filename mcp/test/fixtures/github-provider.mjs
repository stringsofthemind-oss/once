import { createServer } from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

export async function startGitHubFixture(logPath) {
  writeFileSync(logPath, '');
  const authority = { userId: 11, ownerId: 11, repositoryId: 22, owner: 'canary', repo: 'disposable' };
  const controls = { lookup: 'normal', malformed: false, userId: 11, repositoryId: 22, delay: 0 };
  let posts = 0;
  const records = () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const server = createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', Date: controls.lookup === 'stale' && req.url.includes('/issues') ? new Date(0).toUTCString() : new Date().toUTCString() }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== 'Bearer fixture-only-token') return reply(401, {});
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/user') return reply(200, { id: controls.userId });
    if (url.pathname === '/repos/canary/disposable') return reply(200, { id: controls.repositoryId, private: true, has_issues: true, owner: { id: 11, type: 'User' } });
    if (url.pathname === '/repos/canary/disposable/issues' && req.method === 'POST') {
      posts++;
      let data = ''; for await (const chunk of req) data += chunk;
      const args = JSON.parse(data);
      const id = records().length + 1;
      const issue = { id, number: id, title: args.title, body: args.body, repository_url: 'https://api.github.com/repos/canary/disposable', user: { id: 11 }, html_url: `https://github.com/canary/disposable/issues/${id}` };
      appendFileSync(logPath, JSON.stringify(issue) + '\n');
      if (controls.delay) await new Promise(resolve => setTimeout(resolve, controls.delay));
      return reply(201, controls.malformed ? {} : issue);
    }
    if (controls.lookup === 'unavailable') return reply(503, {});
    if (url.pathname === '/repos/canary/disposable/issues') {
      const list = controls.lookup === 'zero' ? [] : records();
      if (controls.lookup === 'duplicate' && list.length) list.push({ ...list.at(-1), number: 999 });
      return reply(200, controls.lookup === 'incomplete' ? {} : list);
    }
    const issue = records().find(x => x.number === Number(url.pathname.split('/').at(-1)));
    if (!issue) return reply(404, {});
    return reply(200, controls.lookup === 'mismatch' ? { ...issue, title: 'tampered' } : issue);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { authority, controls, records, get posts() { return posts; }, url, request: (input, init) => fetch(String(input).replace('https://api.github.com', url), init), close: () => new Promise(resolve => server.close(resolve)) };
}

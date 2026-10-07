import { createServer } from 'node:http';
import { appendFileSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Independent disposable provider. It NEVER reads the Once ledger or response.
 * Every successful create appends a durable provider-owned receipt. There is no
 * native deduplication: a raw duplicate POST really produces a second effect.
 */
export async function startOrderProvider(logPath) {
  writeFileSync(logPath, '');
  const token = randomUUID();
  const modes = new Map();
  const observations = new Map();
  const counters = { posts: 0, lookups: 0, authorityReads: 0 };
  let accountId = 'account-A';
  let holdResolve;
  const records = () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    const reply = x => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(x)); };
    if (req.url === '/authority' && req.method === 'GET') {
      counters.authorityReads++;
      reply({ provider: 'disposable-orders', accountId, environment: 'local-test' }); return;
    }
    if (req.url?.startsWith('/orders/') && req.method === 'GET') {
      counters.lookups++;
      const id = decodeURIComponent(req.url.slice(8));
      if (observations.has(id)) { reply(observations.get(id)); return; }
      const found = records().filter(x => x.operationId === id && x.effect.authority.accountId === accountId);
      reply(found.length === 1 ? { status: 'CONFIRMED', authoritative: true, complete: true, observedAt: Date.now(), receipt: found[0] } : { status: found.length ? 'UNKNOWN' : 'ABSENT' }); return;
    }
    if (req.url === '/orders' && req.method === 'POST') {
      counters.posts++;
      let data = '';
      for await (const chunk of req) data += chunk;
      const { operationId, effect } = JSON.parse(data);
      if (effect.authority.accountId !== accountId) { res.writeHead(403).end(); return; }
      const mode = modes.get(operationId);
      if (mode === 'semantic-failure') { reply({ status: 'failed' }); return; }
      if (mode === 'mcp-isError') { reply({ isError: true, content: [{ type: 'text', text: 'business failure' }] }); return; }
      const receipt = { providerReference: `order-${records().length + 1}`, status: 'created', operationId, effect };
      appendFileSync(logPath, JSON.stringify(receipt) + '\n');
      const fd = openSync(logPath, 'r+'); fsyncSync(fd); closeSync(fd);
      if (mode === 'lost-ack') { res.destroy(); return; }
      if (mode === 'hold') { await new Promise(resolve => { holdResolve = resolve; }); }
      reply(mode === 'bad-receipt' ? { ...receipt, operationId: 'wrong-intent' } : receipt); return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, token, modes, observations, counters, records,
    setAccount: x => { accountId = x; }, release: () => holdResolve?.(),
    close: async () => { holdResolve?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

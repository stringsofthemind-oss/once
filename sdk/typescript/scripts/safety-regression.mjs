import assert from 'node:assert/strict';
import test from 'node:test';
import { Once, OnceTimeoutError, createOnceRuntimeFetch } from '../dist/index.js';

test('timeout covers a stalled response body after headers arrive', async () => {
  let timer;
  const once = new Once({
    apiKey: 'fixture', baseUrl: 'https://once.test', timeoutMs: 15, networkRetries: 0,
    fetchImpl: async (_url, options) => ({
      ok: true,
      text: () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        // Keep the regression bounded even on the defective implementation.
        timer = setTimeout(() => resolve('{"ledger_state":"ABSENT"}'), 150);
      })
    })
  });
  try { await assert.rejects(once.truth('test'), OnceTimeoutError); }
  finally { clearTimeout(timer); }
});

test('reads and explicitly inapplicable POSTs bypass all protection hooks', async () => {
  const native = [];
  const protectedCalls = [];
  let hooks = 0;
  const runtime = createOnceRuntimeFetch({
    apiKey: 'fixture', baseUrl: 'https://once.test', networkRetries: 0,
    shouldProtect: request => new URL(request.url).pathname === '/orders',
    resolveProvider: () => { ++hooks; return 'orders'; },
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).host === 'once.test') {
        protectedCalls.push(await request.json());
        return Response.json({ state: 'CONFIRMED', http_response: { status: 201, body_text: 'created', headers: {} } });
      }
      native.push(request.method + ' ' + new URL(request.url).pathname);
      return new Response('native');
    }
  });
  assert.equal(await (await runtime('https://target.test/search', { method: 'POST', body: '{}' })).text(), 'native');
  assert.equal(await (await runtime('https://target.test/orders')).text(), 'native');
  assert.equal(hooks, 0);
  assert.deepEqual(native, ['POST /search', 'GET /orders']);
  const result = await runtime('https://target.test/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'order:1' }, body: '{}'
  });
  assert.equal(await result.text(), 'created');
  assert.equal(protectedCalls.length, 1);
});

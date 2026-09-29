import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRuntime, storage, execute } from './harness.mjs';

const registered = 'registered_http_v1:pv_' + 'a'.repeat(32);
const putAction = {
  type: 'http_write_v1',
  method: 'PUT',
  url: 'https://target.test/orders/42',
  headers_json: JSON.stringify({ 'content-type': 'application/json', 'x-api-version': '2026-09-01' }),
  body_json: JSON.stringify({ id: 42, state: 'updated' })
};
const config = { allowedUrls: [putAction.url], responseReplay: 'required' };
const replay = { status: 200, body_text: '{"ok":true}', headers: { 'content-type': 'application/json' } };

test('HTTP v1 provider RPC preserves exact PUT action inside POST envelope', async () => {
  const context = await loadRuntime();
  const store = storage();
  const runtime = new context.Runtime({ storage: store }, {});
  try {
    context.fetch = async (url, options) => {
      assert.equal(url, 'https://adapter.test/execute');
      assert.equal(options.method, 'POST', 'provider RPC transport must remain POST');
      const envelope = JSON.parse(options.body);
      assert.equal(envelope.operation_id, 'put-envelope');
      assert.deepEqual(envelope.action, putAction);
      return Response.json({
        operation_id: 'put-envelope',
        provider_executed: true,
        side_effects: 1,
        executed_at: '2026-09-29T20:00:00.000Z',
        http_response: replay
      });
    };
    const result = await runtime.executeHttpV1Provider(
      'put-envelope',
      putAction,
      { baseUrl: 'https://adapter.test', token: 'fixture' }
    );
    assert.equal(result.side_effects, 1);
    assert.equal(result.http_response.body_text, replay.body_text);
  } finally {
    store.db.close();
  }
});

test('registered HTTP PUT reaches execution unchanged and fast replay cannot create a second effect', async () => {
  const { Runtime } = await loadRuntime();
  const store = storage();
  const runtime = new Runtime({ storage: store }, {});
  try {
    runtime.getRegisteredHttpV1Config = async () => config;
    runtime.getProvider = async () => undefined;
    let effects = 0;
    const seen = [];
    runtime.executeProvider = async (provider, operationId, action) => {
      seen.push({ provider, operationId, action: JSON.parse(JSON.stringify(action)) });
      effects += 1;
      return { side_effects: 1, executed_at: '2026-09-29T20:00:00.000Z', http_response: replay };
    };
    const first = await execute(runtime, 'put-proof', { provider: registered, action: putAction });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).state, 'CONFIRMED');
    assert.equal(effects, 1);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].action, putAction);

    runtime.getProvider = async () => { throw new Error('fast replay must not query provider truth'); };
    runtime.executeProvider = async () => { throw new Error('fast replay must not dispatch a second effect'); };
    const second = await execute(runtime, 'put-proof', { provider: registered, action: putAction });
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.state, 'CONFIRMED');
    assert.equal(secondBody.result, 'already_executed');
    assert.equal(effects, 1);
  } finally {
    store.db.close();
  }
});

for (const method of ['PATCH', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'put', 'Put']) {
  test(`registered HTTP method remains fail-closed: ${method}`, async () => {
    const { Runtime } = await loadRuntime();
    const store = storage();
    const runtime = new Runtime({ storage: store }, {});
    try {
      runtime.getRegisteredHttpV1Config = async () => config;
      let dispatched = 0;
      runtime.executeProvider = async () => { dispatched += 1; return { side_effects: 1 }; };
      const response = await execute(runtime, 'reject-' + method, { provider: registered, action: { ...putAction, method } });
      assert.equal(response.status, 400);
      assert.equal(dispatched, 0);
    } finally {
      store.db.close();
    }
  });
}

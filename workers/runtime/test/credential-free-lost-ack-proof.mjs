import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { loadRuntime, storage } from './harness.mjs';

const operationId = 'credential-free-lost-ack-001';
const registered = 'registered_http_v1:pv_' + 'b'.repeat(32);

const action = {
  type: 'http_write_v1',
  method: 'POST',
  url: 'https://credential-free-provider.test/orders',
  body_json: JSON.stringify({ item: 'once-proof' })
};

const replay = {
  status: 201,
  body_text: JSON.stringify({ id: 'provider-order-001' }),
  headers: { 'content-type': 'application/json' }
};

const { Runtime } = await loadRuntime();
const store = storage();
const runtime = new Runtime({ storage: store }, {});

let providerPosts = 0;
let providerEffects = 0;
let truthCalls = 0;
let lostAckInjected = false;

runtime.getRegisteredHttpV1Config = async () => ({
  allowedUrls: [action.url],
  responseReplay: 'required'
});

/*
 * Credential-free external-provider fixture.
 *
 * This state is deliberately independent of the Once ledger.
 * The first execution commits its effect, then loses its acknowledgement.
 */
runtime.executeProvider = async (_provider, id) => {
  ++providerPosts;

  if (id !== operationId) {
    throw new Error('unexpected operation id');
  }

  ++providerEffects;

  if (!lostAckInjected) {
    lostAckInjected = true;
    throw new Error('injected_lost_ack_after_effect');
  }

  throw new Error('SAFETY FAILURE: blind duplicate provider POST');
};

/*
 * Authoritative read-only provider truth.
 * It does not execute or mutate anything.
 */
runtime.getProvider = async (_provider, id) => {
  ++truthCalls;

  if (id !== operationId) return undefined;

  if (providerEffects === 1) {
    return {
      operation_id: operationId,
      side_effects: 1,
      http_response: replay
    };
  }

  return undefined;
};

function onceExecute() {
  return runtime.fetch(
    new Request('https://local.test/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation_id: operationId,
        provider: registered,
        action
      })
    })
  );
}

console.log('\n=== CREDENTIAL-FREE LOST-ACK PROOF ===\n');

const startFirst = performance.now();
const first = await onceExecute();
const firstMs = performance.now() - startFirst;

const firstBody = await first.json().catch(() => ({}));
const afterFirst = runtime.getOperation(operationId);

console.log('First attempt HTTP:       ', first.status);
console.log('First attempt result:     ', firstBody.result ?? firstBody.error ?? '(none)');
console.log('State after lost ack:     ', afterFirst?.state);
console.log('Provider POSTs:           ', providerPosts);
console.log('Provider effects:         ', providerEffects);
console.log('First-attempt latency:    ', firstMs.toFixed(2), 'ms');

assert.equal(providerPosts, 1, 'first attempt must dispatch exactly once');
assert.equal(providerEffects, 1, 'provider must contain exactly one effect');
assert.equal(afterFirst?.state, 'UNKNOWN', 'lost acknowledgement must produce UNKNOWN');

/*
 * Immediate agent/framework retry.
 *
 * This is intentionally BEFORE reconciliation. Once must fail closed rather
 * than issuing another provider POST.
 */
const startRetry = performance.now();
const retry = await onceExecute();
const retryMs = performance.now() - startRetry;

const retryBody = await retry.json().catch(() => ({}));

console.log('\nImmediate retry HTTP:     ', retry.status);
console.log('Immediate retry result:   ', retryBody.result ?? retryBody.error ?? '(none)');
console.log('Provider POSTs after retry:', providerPosts);
console.log('Effects after retry:      ', providerEffects);
console.log('Blocked-retry latency:    ', retryMs.toFixed(2), 'ms');

assert.notEqual(retry.status, 200, 'UNKNOWN retry must not be treated as ordinary execution');
assert.equal(providerPosts, 1, 'UNKNOWN retry must not redispatch');
assert.equal(providerEffects, 1, 'UNKNOWN retry must not duplicate the effect');

/*
 * Run the existing Once reconciliation path.
 * We use the runtime alarm rather than manually changing ledger state.
 */
const startReconcile = performance.now();

/*
 * Simulate recovery of the original provider response from authoritative,
 * read-only provider truth.
 *
 * IMPORTANT:
 * This does NOT execute the provider again.
 * It only persists the response belonging to the already-observed effect.
 */
const authoritativeTruth = await runtime.getProvider(
  registered,
  operationId
);

assert.ok(
  authoritativeTruth,
  'provider truth must find the already-committed effect'
);

assert.equal(
  authoritativeTruth.side_effects,
  1,
  'provider truth must identify exactly one external effect'
);

assert.ok(
  authoritativeTruth.http_response,
  'provider truth must contain the recoverable original HTTP response'
);

runtime.recordHttpResponseReplay(
  operationId,
  {
    status: authoritativeTruth.http_response.status,
    bodyText: authoritativeTruth.http_response.body_text,
    headers: authoritativeTruth.http_response.headers || {}
  }
);

const recoveredReplay = runtime.getHttpResponseReplay(operationId);

assert.ok(
  recoveredReplay,
  'recovered provider response must be durably recorded before confirmation'
);

/*
 * Production reconciliation intentionally uses a delayed alarm.
 *
 * This proof is testing the reconciliation decision itself, not the scheduler
 * delay, so make the already-enqueued UNKNOWN operation due now rather than
 * sleeping for the production backoff interval.
 */
store.sql.exec(
  `
  UPDATE unknown_reconciliation
  SET next_check_at = 0
  WHERE operation_id = ?
  `,
  operationId
);

console.log('');
console.log('Recovered replay status:   ', recoveredReplay.status);
console.log('Recovered replay body:     ', recoveredReplay.body_text);

await runtime.alarm();

const reconcileMs = performance.now() - startReconcile;
const afterReconcile = runtime.getOperation(operationId);

console.log('\nTruth calls:               ', truthCalls);
console.log('State after reconciliation:', afterReconcile?.state);
console.log('Reconciliation latency:   ', reconcileMs.toFixed(2), 'ms');

assert.ok(truthCalls >= 1, 'reconciliation must consult provider truth');
assert.equal(
  afterReconcile?.state,
  'CONFIRMED',
  'authoritative positive truth must confirm UNKNOWN'
);
assert.equal(providerPosts, 1, 'reconciliation must never execute provider mutation');
assert.equal(providerEffects, 1, 'reconciliation must leave exactly one effect');

/*
 * Retry after confirmation.
 * This should reuse confirmed truth/replay, not execute the provider again.
 */
const startFinal = performance.now();
const finalRetry = await onceExecute();
const finalMs = performance.now() - startFinal;
const finalBody = await finalRetry.json().catch(() => ({}));

console.log('\nFinal retry HTTP:          ', finalRetry.status);
console.log('Final retry result:        ', finalBody.result ?? finalBody.error ?? '(none)');
console.log('Safe-retry latency:       ', finalMs.toFixed(2), 'ms');

assert.equal(providerPosts, 1, 'confirmed retry must not redispatch');
assert.equal(providerEffects, 1, 'final provider effect count must remain one');

console.log('\n---------------------------------------------');
console.log('provider POSTs:             ', providerPosts);
console.log('provider effects:           ', providerEffects);
console.log('blind duplicate POSTs:      ', providerPosts - 1);
console.log('UNKNOWN observed:            YES');
console.log('truth reconciliation:        YES');
console.log('final Once state:           ', runtime.getOperation(operationId)?.state);
console.log('lost-ack handling:          ', firstMs.toFixed(2), 'ms');
console.log('blocked retry:              ', retryMs.toFixed(2), 'ms');
console.log('reconciliation:             ', reconcileMs.toFixed(2), 'ms');
console.log('safe final retry:           ', finalMs.toFixed(2), 'ms');
console.log('---------------------------------------------');

assert.equal(providerPosts, 1);
assert.equal(providerEffects, 1);

console.log('\nRESULT: EXACTLY ONE EXTERNAL EFFECT\n');

store.db.close();


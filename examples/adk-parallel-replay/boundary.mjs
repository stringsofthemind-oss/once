// Disposable test boundary. Every request runs in a new Node process.
import { readFileSync, existsSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
const { protectToolCall } = await import(request.sdkUrl || new URL('../../sdk/typescript/dist/index.js', import.meta.url).href);
try {
  // The host remembers whether authority should already exist across restart.
  // Do not let SDK initialization recreate expected-but-missing state.
  if (request.expectedState && !existsSync(request.statePath)) {
    throw Object.assign(Error('Expected ledger missing'), { code: 'STATE_UNAVAILABLE' });
  }
  const result = await protectToolCall({
    operationId: request.operationId,
    effect: request.effect,
    statePath: request.statePath,
    leaseMs: request.leaseMs ?? 1,
    metadata: request.metadata,
    execute: async effect => {
      const response = await fetch(request.providerUrl + '/tickets', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: request.operationId, effect }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Error('Provider response failed');
      const receipt = await response.json();
      if (request.mode === 'crash') process.exit(71);
      if (request.mode === 'lost-ack') throw Error('Acknowledgement lost after provider commit');
      return receipt;
    },
    reconcile: request.reconcile ? async ({ operationId, effect }) => {
      if (request.reconcile === 'NOT_FOUND') return { status: 'NOT_FOUND' };
      if (request.reconcile === 'UNKNOWN') return { status: 'UNKNOWN' };
      const response = await fetch(request.providerUrl + '/lookup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId, effect }), signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { status: 'UNKNOWN' };
      return response.json();
    } : undefined,
  });
  console.log(JSON.stringify({ status: 'CONFIRMED', result }));
} catch (error) {
  console.log(JSON.stringify({ status: error.code || 'ERROR', message: error.message }));
}

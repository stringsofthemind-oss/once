// Host-owned sandbox qualification profile; no agent-selected origin or credentials.
import { createHash } from 'node:crypto';
import { protectToolCall } from '../../dist/index.js';
import { StripeRefundAdapter } from '../../../../workers/gateway/src/stripe-refund-adapter.js';
const origin = 'https://api.stripe.com/v1';
export function createStripeSandboxRefundProfile({ secretKey, expectedAccountId, paymentIntent, amount, currency, authority, fetchImpl = fetch }) {
  if (!/^sk_test_/.test(secretKey ?? '') || !/^acct_/.test(expectedAccountId ?? '') || !/^pi_/.test(paymentIntent ?? '') || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000 || currency !== 'usd' || !authority) throw new Error('Invalid host-pinned sandbox profile');
  const args = Object.freeze({ account: expectedAccountId, paymentIntent, amount, currency });
  const effectHash = createHash('sha256').update(JSON.stringify(['stripe-sandbox-refund-v1', expectedAccountId, paymentIntent, amount, currency])).digest('hex');
  async function read(path) {
    try {
      const response = await fetchImpl(`${origin}${path}`, { headers: { authorization: `Bearer ${secretKey}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch { throw new Error('Sandbox provider truth unavailable'); }
  }
  async function admit() {
    const account = await read('/account');
    const intent = await read(`/payment_intents/${encodeURIComponent(paymentIntent)}`);
    if (account.id !== expectedAccountId || intent.id !== paymentIntent || intent.livemode !== false || intent.status !== 'succeeded' || intent.currency !== currency || !Number.isSafeInteger(intent.amount_received) || intent.amount_received < amount) throw new Error('Sandbox account or complete payment binding rejected');
  }
  const adapter = new StripeRefundAdapter({ secretKey, fetchImpl: (url, options) => fetchImpl(url, { ...options, signal: AbortSignal.timeout(5000) }) });
  function receipt(refund, operationId) {
    if (!refund || refund.object !== 'refund' || refund.payment_intent !== paymentIntent || refund.amount !== amount || refund.currency !== currency || refund.status !== 'succeeded' || typeof refund.id !== 'string' || !refund.id.startsWith('re_') || refund.metadata?.once_operation_id !== operationId || refund.metadata?.once_effect_hash !== effectHash) throw new Error('Exact terminal sandbox refund truth required');
    return { refundId: refund.id, account: expectedAccountId, paymentIntent, amount, currency, status: 'succeeded' };
  }
  async function list(operationId) {
    await admit();
    let after; const matches = [];
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ payment_intent: paymentIntent, limit: '100', ...(after ? { starting_after: after } : {}) });
      const data = await read(`/refunds?${query}`);
      if (!Array.isArray(data.data) || typeof data.has_more !== 'boolean') throw new Error('Incomplete provider listing');
      matches.push(...data.data.filter(r => r.metadata?.once_operation_id === operationId));
      if (!data.has_more) return matches;
      const last = data.data.at(-1)?.id;
      if (typeof last !== 'string' || last === after) throw new Error('Invalid provider pagination');
      after = last;
    }
    throw new Error('Provider listing exceeds bounded qualification scope');
  }
  return Object.freeze({
    // Separate provider read path lets qualification count effects independently.
    observe: list,
    run: (operationId, { loseAcknowledgement = false } = {}) => protectToolCall({ operationId, effect: { tool: 'stripe.sandbox.refund.v1', args }, authority,
      execute: async () => {
        await admit();
        const result = await adapter.execute({ operationId, effectHash, payload: { paymentIntent, amount } });
        const truth = await read(`/refunds/${encodeURIComponent(result.refundId)}`);
        const confirmed = receipt(truth, operationId);
        if (loseAcknowledgement) throw new Error('Qualification injected lost acknowledgement');
        return confirmed;
      },
      reconcile: async () => {
        try { const matches = await list(operationId); return matches.length === 1 ? { status: 'CONFIRMED', result: receipt(matches[0], operationId) } : { status: 'UNKNOWN' }; }
        catch { return { status: 'UNKNOWN' }; }
      },
    }),
  });
}

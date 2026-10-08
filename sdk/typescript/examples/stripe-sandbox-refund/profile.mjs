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
  const counts = { refundPosts: 0, injectedAcknowledgementLosses: 0 };
  async function admit({ forDispatch = false } = {}) {
    const account = await read('/account');
    const intent = await read(`/payment_intents/${encodeURIComponent(paymentIntent)}`);
    if (account.id !== expectedAccountId || intent.id !== paymentIntent || intent.livemode !== false || intent.status !== 'succeeded' || intent.currency !== currency || !Number.isSafeInteger(intent.amount_received) || intent.amount_received < amount) throw new Error('Sandbox account or complete payment binding rejected');
    if (!forDispatch) return;
    if (typeof intent.latest_charge !== 'string' || !/^ch_/.test(intent.latest_charge)) throw new Error('Sandbox captured charge binding required');
    const charge = await read(`/charges/${encodeURIComponent(intent.latest_charge)}`);
    if (charge.id !== intent.latest_charge || charge.object !== 'charge' || charge.payment_intent !== paymentIntent || charge.livemode !== false || charge.currency !== currency || charge.status !== 'succeeded' || charge.paid !== true || charge.captured !== true || charge.disputed !== false || !Number.isSafeInteger(charge.amount_captured) || !Number.isSafeInteger(charge.amount_refunded) || charge.amount_captured < 0 || charge.amount_refunded < 0 || charge.amount_refunded > charge.amount_captured || charge.amount_captured - charge.amount_refunded < amount) throw new Error('Sandbox remaining refundable balance or charge binding rejected');
  }
  const adapter = new StripeRefundAdapter({ secretKey, fetchImpl: (url, options) => fetchImpl(url, { ...options, signal: AbortSignal.timeout(5000) }) });
  function receipt(refund, operationId) {
    if (!refund || refund.object !== 'refund' || refund.payment_intent !== paymentIntent || refund.amount !== amount || refund.currency !== currency || refund.status !== 'succeeded' || typeof refund.id !== 'string' || !refund.id.startsWith('re_') || refund.metadata?.once_operation_id !== operationId || refund.metadata?.once_effect_hash !== effectHash) throw new Error('Exact terminal sandbox refund truth required');
    return { refundId: refund.id, account: expectedAccountId, paymentIntent, amount, currency, status: 'succeeded' };
  }
  async function list(operationId, { all = false } = {}) {
    await admit();
    let after; const matches = [], seen = new Set();
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ payment_intent: paymentIntent, limit: '100', ...(after ? { starting_after: after } : {}) });
      const data = await read(`/refunds?${query}`);
      if (!Array.isArray(data.data) || typeof data.has_more !== 'boolean') throw new Error('Incomplete provider listing');
      for (const refund of data.data) {
        if (!refund || refund.object !== 'refund' || refund.payment_intent !== paymentIntent || typeof refund.id !== 'string' || !/^re_[A-Za-z0-9]+$/.test(refund.id) || seen.has(refund.id)) throw new Error('Invalid or duplicated provider listing');
        seen.add(refund.id);
      }
      matches.push(...data.data.filter(r => all || r.metadata?.once_operation_id === operationId));
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
    // Validate independently listed truth even when the kernel returns a cached receipt.
    validateObservedRefund: receipt,
    // Allowlisted local counters distinguish transport attempts from provider effects.
    diagnostics: () => ({ ...counts }),
    run: (operationId, { loseAcknowledgement = false, withholdReconciliation = false } = {}) => {
      if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(operationId)) throw new Error('Invalid bounded qualification operation identity');
      return protectToolCall({ operationId, effect: { tool: 'stripe.sandbox.refund.v1', args }, authority,
      execute: async () => {
        // A provider effect without retained authority history is not a fresh intent.
        if ((await list(operationId)).length !== 0) throw new Error('Existing provider effect requires retained authority and investigation');
        await admit({ forDispatch: true });
        counts.refundPosts++;
        const result = await adapter.execute({ operationId, effectHash, payload: { paymentIntent, amount } });
        const truth = await read(`/refunds/${encodeURIComponent(result.refundId)}`);
        const confirmed = receipt(truth, operationId);
        if (loseAcknowledgement) { counts.injectedAcknowledgementLosses++; throw new Error('Qualification injected lost acknowledgement'); }
        return confirmed;
      },
      reconcile: async () => {
        if (withholdReconciliation) return { status: 'UNKNOWN' };
        try { const matches = await list(operationId); return matches.length === 1 ? { status: 'CONFIRMED', result: receipt(matches[0], operationId) } : { status: 'UNKNOWN' }; }
        catch { return { status: 'UNKNOWN' }; }
      },
    }); },
  });
}

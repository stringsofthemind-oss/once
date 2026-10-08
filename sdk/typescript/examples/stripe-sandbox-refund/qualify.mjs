import pg from 'pg';
import { verifiedDatabaseConfig } from './verified-database.mjs';
import { writeFileSync } from 'node:fs';
import { createPostgresContinuityWitness, createPostgresExecutionAuthority } from '../../dist/index.js';
import { createStripeSandboxRefundProfile } from './profile.mjs';
import { qualifyRefund } from './qualification.mjs';
const required = ['STRIPE_SANDBOX_SECRET_KEY','STRIPE_SANDBOX_ACCOUNT_ID','STRIPE_SANDBOX_PAYMENT_INTENT','ONCE_EXECUTION_DATABASE','ONCE_CONTINUITY_DATABASE','ONCE_AUTHORITY_ID','ONCE_AUTHORITY_GENERATION','ONCE_AUTHORITY_EPOCH','ONCE_WITNESS_ID','ONCE_QUALIFICATION_OPERATION_ID'];
let pools = [];
const evidence = { status: 'BLOCKED', scope: 'Stripe sandbox USD 1 refund only; native idempotency retained; not production certification', failureInjection: 'Local exception after Stripe refund readback; withheld reconciliation is simulated; pool restart is not OS worker termination' };
function openProfiles() {
  pools = ['ONCE_EXECUTION_DATABASE','ONCE_CONTINUITY_DATABASE'].map(name => new pg.Pool(verifiedDatabaseConfig(process.env[name])));
  for (const pool of pools) pool.on('error', () => {});
  const authority = createPostgresExecutionAuthority({ pool: pools[0], witness: createPostgresContinuityWitness({ pool: pools[1], expectedWitnessId: process.env.ONCE_WITNESS_ID }), authorityId: process.env.ONCE_AUTHORITY_ID, expectedGeneration: process.env.ONCE_AUTHORITY_GENERATION, expectedEpoch: process.env.ONCE_AUTHORITY_EPOCH });
  const config = { secretKey: process.env.STRIPE_SANDBOX_SECRET_KEY, expectedAccountId: process.env.STRIPE_SANDBOX_ACCOUNT_ID, paymentIntent: process.env.STRIPE_SANDBOX_PAYMENT_INTENT, amount: 100, currency: 'usd', authority };
  return { profile: createStripeSandboxRefundProfile(config), changedProfile: createStripeSandboxRefundProfile({ ...config, amount: 101 }) };
}
async function closePools() { await Promise.all(pools.map(p => p.end())); pools = []; }
try {
  evidence.missingBindings = required.filter(name => !process.env[name]);
  if (evidence.missingBindings.length) throw new Error();
  evidence.status = 'UNVERIFIED';
  const operationId = process.env.ONCE_QUALIFICATION_OPERATION_ID;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(operationId)) throw new Error();
  evidence.operationId = operationId;
  const profiles = openProfiles();
  // Diagnostic only: SQL read never grants execution or replaces witness admission.
  const readState = async () => {
    const result = await pools[0].query('SELECT state FROM once_execution.operations WHERE authority_id=$1 AND id=$2', [process.env.ONCE_AUTHORITY_ID, operationId]);
    return result.rows[0]?.state ?? null;
  };
  await qualifyRefund({ ...profiles, operationId, readState, restart: async () => { await closePools(); return openProfiles(); }, evidence });
  if (!evidence.freshLostAcknowledgementQualified) process.exitCode = 2;
  console.log(evidence.freshLostAcknowledgementQualified ? 'PASS: fresh sandbox acknowledgement loss, durable UNKNOWN, reconciliation, replay/conflict and one provider effect verified' : 'PARTIAL: existing operation recovery/replay passed; fresh acknowledgement-loss qualification remains unsatisfied');
} catch {
  evidence.outcome = 'FAILED_CLOSED';
  console.error('Sandbox qualification blocked or failed closed. Preserve operation identity and authorities; investigate using authenticated provider reads. No error details printed.');
  process.exitCode = 1;
} finally {
  try { await closePools(); } catch { process.exitCode = 1; evidence.status = 'UNVERIFIED'; evidence.outcome = 'FAILED_CLOSED'; }
  writeFileSync('stripe-sandbox-qualification.json', JSON.stringify(evidence, null, 2), { mode: 0o600 });
}

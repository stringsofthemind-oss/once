import pg from 'pg';
import { verifiedDatabaseConfig } from './verified-database.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createPostgresContinuityWitness, createPostgresExecutionAuthority } from '../../dist/index.js';
import { createStripeSandboxRefundProfile } from './profile.mjs';
const required = ['STRIPE_SANDBOX_SECRET_KEY','STRIPE_SANDBOX_ACCOUNT_ID','STRIPE_SANDBOX_PAYMENT_INTENT','ONCE_EXECUTION_DATABASE','ONCE_CONTINUITY_DATABASE','ONCE_AUTHORITY_ID','ONCE_AUTHORITY_GENERATION','ONCE_AUTHORITY_EPOCH','ONCE_WITNESS_ID','ONCE_QUALIFICATION_OPERATION_ID'];
if (required.some(name=>!process.env[name])) throw new Error('Host-managed sandbox/authority bindings missing. No provider write attempted. See README.');
// Verified TLS, host-owned credentials, finite transport timeouts. Never print pools/errors.
const pools = ['ONCE_EXECUTION_DATABASE','ONCE_CONTINUITY_DATABASE'].map(name=>new pg.Pool(verifiedDatabaseConfig(process.env[name])));
for(const p of pools)p.on('error',()=>{});
try {
 const authority=createPostgresExecutionAuthority({pool:pools[0],witness:createPostgresContinuityWitness({pool:pools[1],expectedWitnessId:process.env.ONCE_WITNESS_ID}),authorityId:process.env.ONCE_AUTHORITY_ID,expectedGeneration:process.env.ONCE_AUTHORITY_GENERATION,expectedEpoch:process.env.ONCE_AUTHORITY_EPOCH});
 const config={secretKey:process.env.STRIPE_SANDBOX_SECRET_KEY,expectedAccountId:process.env.STRIPE_SANDBOX_ACCOUNT_ID,paymentIntent:process.env.STRIPE_SANDBOX_PAYMENT_INTENT,amount:100,currency:'usd',authority};
 const profile=createStripeSandboxRefundProfile(config), id=process.env.ONCE_QUALIFICATION_OPERATION_ID;
 const before=await profile.observe(id);assert.ok(before.length<=1,'Existing duplicate effects require investigation');
 let lostAck;
 try {await profile.run(id,{loseAcknowledgement:true});lostAck='already-confirmed-replay';}catch(error){assert.equal(error.code,'UNKNOWN');lostAck='UNKNOWN';}
 const result=await profile.run(id);
 assert.deepEqual(await profile.run(id),result);
 await assert.rejects(createStripeSandboxRefundProfile({...config,amount:101}).run(id),{code:'CONFLICT'});
 const effects=await profile.observe(id);assert.equal(effects.length,1);assert.equal(effects[0].id,result.refundId);
 writeFileSync('stripe-sandbox-qualification.json',JSON.stringify({scope:'Stripe sandbox only; one host-controlled USD 1 refund of a preexisting test payment; not production/provider certification',operationId:id,lostAck,observedEffects:effects.length,result},null,2));
 console.log('PASS: sandbox provider readback found one exact terminal refund; replay and conflict passed');
} catch { console.error('Sandbox qualification failed closed. Preserve operation identity and authorities; investigate using authenticated provider reads. No error details printed.');process.exitCode=1; }
finally {for(const p of pools)await p.end();}

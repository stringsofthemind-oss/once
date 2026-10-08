import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPostgresExecutionAuthority, createPostgresContinuityWitness } from '../dist/index.js';
import { createStripeSandboxRefundProfile } from '../examples/stripe-sandbox-refund/profile.mjs';
import { qualifyRefund, refundEvidence } from '../examples/stripe-sandbox-refund/qualification.mjs';
if (!process.env.ONCE_TEST_POSTGRES) throw new Error('Disposable PostgreSQL required; no silently skipped qualification test');
test('sandbox profile preserves native key and independently counts lost-ack effect', async t => {
 const admin = new pg.Pool({connectionString:process.env.ONCE_TEST_POSTGRES});
 const names = [0,1].map(()=>`once_stripe_${randomUUID().replaceAll('-','')}`), pools=[];
 for(const name of names) { await admin.query(`CREATE DATABASE ${name}`); const url=new URL(process.env.ONCE_TEST_POSTGRES);url.pathname=`/${name}`;pools.push(new pg.Pool({connectionString:url.href})); }
 t.after(async()=>{for(const p of pools)await p.end();for(const name of names)await admin.query(`DROP DATABASE ${name}`);await admin.end();});
 await pools[0].query(readFileSync(new URL('../sql/execution-authority-v1.sql',import.meta.url),'utf8'));
 await pools[1].query(readFileSync(new URL('../sql/continuity-witness-v1.sql',import.meta.url),'utf8'));
 await pools[0].query("INSERT INTO once_execution.authorities VALUES('stripe',1,'g1',1,0)");
 await pools[1].query("INSERT INTO once_continuity.metadata VALUES(true,'stripe-witness',1); INSERT INTO once_continuity.checkpoints VALUES('stripe','g1',1,0)");
 const authority=createPostgresExecutionAuthority({pool:pools[0],witness:createPostgresContinuityWitness({pool:pools[1],expectedWitnessId:'stripe-witness'}),authorityId:'stripe',expectedGeneration:'g1',expectedEpoch:'1'});
 const journal=[]; const keys=[]; let bad=false, duplicate=false, chargeChange={}, intentChange={}, refundChange={}, listingOverride;
 const fetchImpl=async (url,options={})=>{
  const path=new URL(url).pathname;
  let data;
  if(path.endsWith('/account'))data={id:'acct_fixture'};
  else if(path.includes('/payment_intents/'))data={id:'pi_fixture',livemode:false,status:'succeeded',currency:'usd',amount_received:1000,latest_charge:'ch_fixture',...intentChange};
  else if(path.includes('/charges/'))data={id:'ch_fixture',object:'charge',payment_intent:'pi_fixture',livemode:false,status:'succeeded',currency:'usd',paid:true,captured:true,disputed:false,amount_captured:1000,amount_refunded:journal.reduce((sum,r)=>sum+r.amount,0),...chargeChange};
  else if(options.method==='POST') { const body=options.body; keys.push(options.headers['idempotency-key']); data={id:`re_fixture${journal.length}`,object:'refund',payment_intent:body.get('payment_intent'),amount:Number(body.get('amount')),currency:'usd',status:'succeeded',metadata:{once_operation_id:body.get('metadata[once_operation_id]'),once_effect_hash:body.get('metadata[once_effect_hash]')}}; journal.push(data); }
  else if(path.endsWith('/refunds'))data=listingOverride ? listingOverride(url) : {data:duplicate?[...journal,...journal.map(r=>({...r,id:`${r.id}duplicate`}))]:journal.map(r=>({...r,...(r.metadata.once_operation_id==='qualification-fresh'?refundChange:{}),...(bad?{status:'pending'}:{})})),has_more:false};
  else data=journal.find(r=>path.endsWith(`/${r.id}`));
  return {ok:true,json:async()=>data};
 };
 const config={secretKey:'sk_test_fixture',expectedAccountId:'acct_fixture',paymentIntent:'pi_fixture',amount:100,currency:'usd',authority,fetchImpl};
 const profile=createStripeSandboxRefundProfile(config);
 await assert.rejects(profile.run('lost-ack',{loseAcknowledgement:true}),{code:'UNKNOWN'});
 assert.equal(journal.length,1); assert.deepEqual(keys,['once:lost-ack']);
 bad=true; await assert.rejects(profile.run('lost-ack'),{code:'UNKNOWN'});
 bad=false;duplicate=true;await assert.rejects(profile.run('lost-ack'),{code:'UNKNOWN'});
 duplicate=false; const result=await profile.run('lost-ack');assert.equal(result.refundId,'re_fixture0');
 await profile.run('lost-ack');assert.equal((await profile.observe('lost-ack')).length,1);assert.equal(keys.length,1);
 await assert.rejects(createStripeSandboxRefundProfile({...config,amount:101}).run('lost-ack'),{code:'CONFLICT'});
 for(const change of [{secretKey:'sk_live_bad'},{expectedAccountId:'not-account'},{currency:'gbp'},{amount:1001}])assert.throws(()=>createStripeSandboxRefundProfile({...config,...change}));

 await t.test('captured refundable balance and test charge binding fail before POST',async()=>{
  for(const [index,change] of [{amount_refunded:901},{amount_refunded:1000},{amount_refunded:1001},{amount_refunded:-1},{amount_refunded:'0'},{amount_captured:NaN},{livemode:true},{payment_intent:'pi_other'},{currency:'gbp'},{captured:false},{paid:false},{disputed:true},{status:'pending'},{object:'other'},{id:'ch_other'}].entries()) {
   chargeChange=change;
   await assert.rejects(profile.run(`balance-${index}`),{code:'UNKNOWN'});
   assert.equal(keys.length,1);
  }
  chargeChange={};
  for(const [index,change] of [{livemode:true},{latest_charge:null},{latest_charge:{id:'ch_fixture'}}].entries()) {
   intentChange=change;await assert.rejects(profile.run(`intent-${index}`),{code:'UNKNOWN'});assert.equal(keys.length,1);
  }
  intentChange={};
 });
 await t.test('fresh qualification and confirmed rerun have distinct evidence',async()=>{
  const operationId='qualification-fresh';
  const readState=async()=> (await pools[0].query('SELECT state FROM once_execution.operations WHERE authority_id=$1 AND id=$2',['stripe',operationId])).rows[0]?.state??null;
  const makeProfiles=()=>({profile:createStripeSandboxRefundProfile(config),changedProfile:createStripeSandboxRefundProfile({...config,amount:101})});
  const evidence={};
  await qualifyRefund({...makeProfiles(),operationId,readState,restart:async()=>{
   await Promise.all(pools.map(p=>p.end()));
   for(let index=0;index<names.length;index++){const url=new URL(process.env.ONCE_TEST_POSTGRES);url.pathname=`/${names[index]}`;pools[index]=new pg.Pool({connectionString:url.href});}
   config.authority=createPostgresExecutionAuthority({pool:pools[0],witness:createPostgresContinuityWitness({pool:pools[1],expectedWitnessId:'stripe-witness'}),authorityId:'stripe',expectedGeneration:'g1',expectedEpoch:'1'});
   // Provider charge becomes fully refunded after our write: recovery remains admissible.
   chargeChange={amount_refunded:1000};return makeProfiles();
  },evidence});
  assert.equal(evidence.freshLostAcknowledgementQualified,true);assert.equal(evidence.firstProcess.refundPosts,1);
  assert.equal(evidence.recoveryProcess.refundPosts,0);assert.equal(keys.length,2);
  const replay={};await qualifyRefund({...makeProfiles(),operationId,readState,restart:async()=>makeProfiles(),evidence:replay});
  assert.equal(replay.freshLostAcknowledgementQualified,false);assert.equal(replay.status,'TESTED');assert.equal(replay.qualification,'RECOVERY_ONLY');assert.equal(keys.length,2);
  for(const change of [{status:'pending'},{amount:999},{currency:'gbp'},{metadata:{once_operation_id:operationId,once_effect_hash:'wrong'}}]) {
   refundChange=change;
   try {
    await assert.rejects(qualifyRefund({...makeProfiles(),operationId,readState,restart:async()=>makeProfiles(),evidence:{}}),/Exact terminal sandbox refund truth required/);
    assert.equal(keys.length,2);
   } finally { refundChange={}; }
  }
  chargeChange={};
 });
 await t.test('missing authority history with existing provider effect cannot dispatch',async()=>{
  const operationId='lost-ack', evidence={}, freshProfile=createStripeSandboxRefundProfile(config);
  await assert.rejects(qualifyRefund({profile:freshProfile,operationId,readState:async()=>null,restart:async()=>{throw new Error('must not restart');},evidence}),/without authority history/);
  assert.equal(freshProfile.diagnostics().refundPosts,0);assert.equal(keys.length,2);
  // Remove only the test row to model incomplete execution history; provider journal survives.
  await pools[0].query('DELETE FROM once_execution.operations WHERE authority_id=$1 AND id=$2',['stripe',operationId]);
  await assert.rejects(freshProfile.run(operationId),{code:'UNKNOWN'});
  assert.equal(freshProfile.diagnostics().refundPosts,0);assert.equal(keys.length,2);
 });
 await t.test('bounded identity validation and credential-safe evidence',async()=>{
  for(const id of ['', 'x'.repeat(201),'newline\nidentity'])assert.throws(()=>profile.run(id),/operation identity/);
  const safe=refundEvidence([{id:'re_safe',object:'refund',payment_intent:'pi_fixture',amount:100,currency:'usd',status:'succeeded',secret:'synthetic-secret',metadata:{secret:'synthetic-secret'}}]);
  assert.equal(JSON.stringify(safe).includes('synthetic-secret'),false);
 });
 await t.test('malformed, repeating or over-bound provider history fails closed',async()=>{
  const sample=journal[0];
  for(const listing of [{data:[],has_more:'false'},{data:[sample,sample],has_more:false},{data:[{...sample,payment_intent:'pi_other'}],has_more:false},{data:[],has_more:true}]){
   listingOverride=()=>listing;await assert.rejects(profile.observe('lost-ack'));
  }
  let page=0;listingOverride=()=>({data:[{...sample,id:`re_page${page++}`}],has_more:true});
  await assert.rejects(profile.observe('lost-ack'),/bounded qualification scope/);assert.equal(page,10);
  listingOverride=undefined;assert.equal(keys.length,2);
 });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPostgresExecutionAuthority, createPostgresContinuityWitness } from '../dist/index.js';
import { createStripeSandboxRefundProfile } from '../examples/stripe-sandbox-refund/profile.mjs';
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
 const journal=[]; const keys=[]; let bad=false, duplicate=false;
 const fetchImpl=async (url,options={})=>{
  const path=new URL(url).pathname;
  let data;
  if(path.endsWith('/account'))data={id:'acct_fixture'};
  else if(path.includes('/payment_intents/'))data={id:'pi_fixture',livemode:false,status:'succeeded',currency:'usd',amount_received:1000};
  else if(options.method==='POST') { const body=options.body; keys.push(options.headers['idempotency-key']); data={id:'re_fixture',livemode:false,payment_intent:body.get('payment_intent'),amount:Number(body.get('amount')),currency:'usd',status:'succeeded',metadata:{once_operation_id:body.get('metadata[once_operation_id]'),once_effect_hash:body.get('metadata[once_effect_hash]')}}; journal.push(data); }
  else if(path.endsWith('/refunds'))data={data:duplicate?[...journal,...journal]:journal.map(r=>bad?{...r,status:'pending'}:r),has_more:false};
  else data=journal[0];
  return {ok:true,json:async()=>data};
 };
 const config={secretKey:'sk_test_fixture',expectedAccountId:'acct_fixture',paymentIntent:'pi_fixture',amount:100,currency:'usd',authority,fetchImpl};
 const profile=createStripeSandboxRefundProfile(config);
 await assert.rejects(profile.run('lost-ack',{loseAcknowledgement:true}),{code:'UNKNOWN'});
 assert.equal(journal.length,1); assert.deepEqual(keys,['once:lost-ack']);
 bad=true; await assert.rejects(profile.run('lost-ack'),{code:'UNKNOWN'});
 bad=false;duplicate=true;await assert.rejects(profile.run('lost-ack'),{code:'UNKNOWN'});
 duplicate=false; const result=await profile.run('lost-ack');assert.equal(result.refundId,'re_fixture');
 await profile.run('lost-ack');assert.equal((await profile.observe('lost-ack')).length,1);assert.equal(keys.length,1);
 await assert.rejects(createStripeSandboxRefundProfile({...config,amount:101}).run('lost-ack'),{code:'CONFLICT'});
 for(const change of [{secretKey:'sk_live_bad'},{expectedAccountId:'not-account'},{currency:'gbp'},{amount:1001}])assert.throws(()=>createStripeSandboxRefundProfile({...config,...change}));
});

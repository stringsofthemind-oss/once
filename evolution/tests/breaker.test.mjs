import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReceipt } from '../kernel/campaign.mjs';
import { digest, json, root } from '../kernel/common.mjs';
import { resolve } from 'node:path';

function forgedReceipt(overrides={}) {
  const schema=json(resolve(root,'evolution/schemas/receipt.schema.json'));
  const receipt=Object.fromEntries(schema.required.map(name=>[name,{}]));
  Object.assign(receipt,{schemaVersion:1,generation:0,riskRing:4,decision:'ELIGIBLE_FOR_HUMAN_PROMOTION',hardGates:{},cleanReproduction:'claimed PASS',...overrides});
  delete receipt.receiptHash;
  receipt.receiptHash=digest(receipt);
  return receipt;
}

test('Breaker: empty gates and a recomputed receipt hash cannot establish eligibility',()=>{
  assert.throws(()=>validateReceipt(forgedReceipt()));
});

test('Breaker: rejection does not bypass receipt type and generation validation',()=>{
  assert.throws(()=>validateReceipt(forgedReceipt({decision:'REJECTED',generation:-1,candidateCommit:'not-a-commit'})));
});

test('Breaker: schema and emitted version agree',()=>{
  const schema=json(resolve(root,'evolution/schemas/receipt.schema.json'));
  assert.equal(schema.properties.schemaVersion.type,'integer');
  assert.equal(schema.properties.schemaVersion.const,1);
});

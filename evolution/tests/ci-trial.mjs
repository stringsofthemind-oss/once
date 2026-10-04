// Trusted CI entry point authorized only for isolated trial, never production.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { json } from '../kernel/common.mjs';
import { approveTrial, validateReceipt } from '../kernel/campaign.mjs';
const out=resolve(process.argv[2]);
const receipt=validateReceipt(json(resolve(out,'receipts/g0-strategy-M1.json')));
assert.equal(receipt.decision,'ELIGIBLE_FOR_HUMAN_PROMOTION');
const state=approveTrial(out,receipt.candidateId,receipt.receiptHash);
assert.equal(state.status,'COMPLETE_HUMAN_PRODUCTION_GATE');assert.equal(state.recursion.demonstrated,true);
assert.equal(state.recursion.actuallyUsed.version,'M1');assert(state.recursion.M1.killed>state.recursion.M0.killed);
for(const node of state.lineage)validateReceipt(json(resolve(out,'receipts',node.id+'.json')));
console.log(JSON.stringify({recursion:state.recursion,resourceUsage:state.resourceUsage},null,2));

// Trusted CI entry point authorized only for isolated trial, never production.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { json, atomic, digest } from '../kernel/common.mjs';
import { approveTrial, validateReceipt, loadState, boundReceipt } from '../kernel/campaign.mjs';
const out=resolve(process.argv[2]);
const receipt=validateReceipt(json(resolve(out,'receipts/g0-strategy-M1.json')));
assert.equal(receipt.decision,'ELIGIBLE_FOR_HUMAN_PROMOTION');
const state=approveTrial(out,receipt.candidateId,receipt.receiptHash);
assert.equal(state.status,'COMPLETE_HUMAN_PRODUCTION_GATE');assert.equal(state.recursion.demonstrated,true);
assert.equal(state.recursion.actuallyUsed.version,'M1');assert(state.recursion.M1.killed>state.recursion.M0.killed);
for(const node of state.lineage)boundReceipt(out,loadState(out),node.id);
// Independently reproduce evidence forgery after the successful campaign.
const file=resolve(out,'receipts/g0-prerequisite-first.json'),original=json(file);
const forged={...original,decisionReason:'forged evidence with a recomputed self-hash'};delete forged.receiptHash;forged.receiptHash=digest(forged);
atomic(file,forged);assert.throws(()=>boundReceipt(out,loadState(out),original.candidateId),/RECEIPT_PROVENANCE_MISMATCH/);atomic(file,original);
const stateFile=resolve(out,'campaign.json'),originalState=json(stateFile);atomic(stateFile,{...originalState,status:'forged'});assert.throws(()=>loadState(out),/CAMPAIGN_TAMPERED/);atomic(stateFile,originalState);
assert.throws(()=>approveTrial(out,receipt.candidateId,receipt.receiptHash),/INVALID_CAMPAIGN_STATE/);
console.log(JSON.stringify({recursion:state.recursion,resourceUsage:state.resourceUsage},null,2));

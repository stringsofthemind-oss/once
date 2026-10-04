#!/usr/bin/env node
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runCampaign, approveTrial, validateReceipt, loadState } from './kernel/campaign.mjs';
import { json, safeOutput, verifyKernel } from './kernel/common.mjs';

const [command='help',...args]=process.argv.slice(2);
function value(name){const exact=args.find(x=>x.startsWith(name+'='));if(exact)return exact.slice(name.length+1);const i=args.indexOf(name);return i<0?undefined:args[i+1];}
try {
  if(command==='help')console.log('Once Evolution v0.1 (maintainer, data-only)\nrun --out <new-outside-repository>\nstatus|inspect|candidates|lineage --out <campaign-directory>\nreceipt|rollback-info <candidate-id> --out <campaign-directory>\napprove-trial <candidate-id> --receipt-sha256=<exact-hash> --out <campaign-directory>\nNo command merges, publishes or deploys.');
  else {
    const out=value('--out');if(!out)throw new Error('OUT_REQUIRED');
    if(command==='run') {const state=runCampaign(out);console.log(JSON.stringify({campaignId:state.campaignId,status:state.status,lineage:state.lineage,resourceUsage:state.resourceUsage},null,2));}
    else if(command==='approve-trial'){const state=approveTrial(out,args[0],value('--receipt-sha256'));console.log(JSON.stringify({status:state.status,recursion:state.recursion,resourceUsage:state.resourceUsage},null,2));}
    else {
      verifyKernel();const directory=safeOutput(out);
      if(command==='status'&&!existsSync(resolve(directory,'campaign.json'))){const failure=resolve(directory,'failure.json');console.log(JSON.stringify(json(existsSync(failure)?failure:resolve(directory,'progress.json')),null,2));process.exit(0);}
      const state=loadState(directory);
      if(command==='status')console.log(JSON.stringify({campaignId:state.campaignId,status:state.status,generation:state.generation,resourceUsage:state.resourceUsage},null,2));
      else if(command==='inspect')console.log(JSON.stringify(state,null,2));
      else if(['candidates','lineage'].includes(command))console.log(JSON.stringify(state.lineage,null,2));
      else if(['receipt','rollback-info'].includes(command)) {
        if(!/^g[01]-[a-zA-Z0-9-]+$/.test(args[0]??''))throw new Error('INVALID_CANDIDATE_ID');
        const receipt=validateReceipt(json(resolve(directory,'receipts',args[0]+'.json')));console.log(JSON.stringify(command==='receipt'?receipt:receipt.rollback,null,2));
      } else throw new Error('UNKNOWN_COMMAND');
    }
  }
} catch(e) {console.error(JSON.stringify({error:e.message,status:'FAIL_CLOSED'}));process.exitCode=1;}

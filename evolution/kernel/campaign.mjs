import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { platform, release, arch } from 'node:os';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { root, constitution, hash, digest, canonical, json, atomic, Budget, safeOutput, verifyKernel, validateStrategy, operators, artifactManifest, verifyArtifacts } from './common.mjs';
import { validateSchema } from './schema.mjs';
import { coldMetrics, documentationGates, applyDocumentation } from './docs-evaluator.mjs';
import { evaluateStrength, ordinary, safety } from './evaluate.mjs';

export function validateReceipt(receipt) {
  const schema=json(resolve(root,'evolution/schemas/receipt.schema.json'));
  validateSchema(receipt,schema);
  if(!['REJECTED','INELIGIBLE','ELIGIBLE_FOR_HUMAN_PROMOTION'].includes(receipt.decision) || receipt.schemaVersion!==1 || !Number.isInteger(receipt.generation)||![0,1,2,3,4].includes(receipt.riskRing))throw new Error('INVALID_RECEIPT_TYPE');
  if(receipt.decision==='ELIGIBLE_FOR_HUMAN_PROMOTION' && (receipt.riskRing<2||Object.values(receipt.hardGates).some(x=>x!==true)||receipt.cleanReproduction?.passed!==true||!receipt.promotionEligibility))throw new Error('INVALID_ADMISSION');
  const copy={...receipt};delete copy.receiptHash;if(digest(copy)!==receipt.receiptHash)throw new Error('RECEIPT_TAMPERED');
  return receipt;
}
function sealState(out,state) {
  const keyFile=resolve(out,'.kernel-seal-key');
  if(!existsSync(keyFile))writeFileSync(keyFile,randomBytes(32),{flag:'wx',mode:0o600});
  const copy={...state};delete copy.kernelSeal;
  state.kernelSeal=createHmac('sha256',readFileSync(keyFile)).update(canonical(copy)).digest('hex');
  atomic(resolve(out,'campaign.json'),state);
}
export function loadState(out) {
  const state=json(resolve(out,'campaign.json')),copy={...state};delete copy.kernelSeal;
  const expected=createHmac('sha256',readFileSync(resolve(out,'.kernel-seal-key'))).update(canonical(copy)).digest('hex');
  if(typeof state.kernelSeal!=='string'||state.kernelSeal.length!==64||!timingSafeEqual(Buffer.from(expected),Buffer.from(state.kernelSeal)))throw new Error('CAMPAIGN_TAMPERED');
  return state;
}
function recordReceipt(out,value) {
  value.receiptHash=digest(value);validateReceipt(value);atomic(resolve(out,'receipts',value.candidateId+'.json'),value);return value;
}
export function inspectCandidate(budget,path,baseline) {
  const files=budget.git(['diff','--name-only',baseline,'HEAD'],path).split('\n').filter(Boolean);
  const raw=budget.git(['diff','--raw',baseline,'HEAD'],path);
  if(raw.includes('120000')||raw.includes('160000'))throw new Error('LINK_OR_SUBMODULE');
  const status=budget.git(['status','--porcelain','--untracked-files=all','--ignored'],path);
  if(status)throw new Error('UNCOMMITTED_OR_IGNORED_CANDIDATE_FILES');
  const diff=budget.git(['diff','--binary',baseline,'HEAD'],path);
  if(Buffer.byteLength(diff)>constitution.limits.diffBytes)throw new Error('DIFF_LIMIT');
  const denied=files.filter(file=>!constitution.candidatePaths.includes(file));
  if(denied.length)throw new Error('PROTECTED_PATH: '+denied.join(','));
  for(const file of files)if(lstatSync(resolve(path,file)).isSymbolicLink())throw new Error('LINK');
  return {files,diff,bytes:Buffer.byteLength(diff),sha256:hash(diff)};
}
function proposalOutput(budget,out,generation,strategy,knowledge,label='actual') {
  validateStrategy(strategy);
  const dir=resolve(out,'generation-'+generation+'-'+strategy.version+'-'+label);mkdirSync(dir,{recursive:true});
  const input=resolve(dir,'input.json'), output=resolve(dir,'output.json'),worker=resolve(root,'evolution/kernel/candidate-worker.mjs');
  atomic(input,{generation,strategy,knowledge});
  const result=budget.run(process.execPath,['--permission','--allow-fs-read='+worker,'--allow-fs-read='+input,'--allow-fs-write='+output,worker,input,output],{cwd:dir});
  if(result.status!==0)throw new Error('CANDIDATE_WORKER_FAILED: '+result.stderr);
  const data=json(output);
  if(data.proposals.length>constitution.limits.candidatesPerGeneration)throw new Error('CANDIDATE_LIMIT');
  return data;
}
function buildCandidate(budget,out,baseline,proposal,generation) {
  const id=`g${generation}-${proposal.id}`, path=resolve(out,'worktrees',id);
  budget.git(['worktree','add','--detach',path,baseline]);
  const htmlFile=resolve(path,'docs/first10/index.html'), guideFile=resolve(path,'examples/first10/README.md');
  if(proposal.operation==='tamper')writeFileSync(resolve(path,'evolution/kernel/docs-evaluator.mjs'),'// candidate claims PASS without evaluating\n');
  else if(proposal.operation==='improve-strategy')atomic(resolve(path,'evolution/zone/strategy.json'),{version:'M1',operators,casesPerOperator:2});
  else {
    const value=applyDocumentation(proposal.operation,readFileSync(htmlFile,'utf8'),readFileSync(guideFile,'utf8'));
    writeFileSync(htmlFile,value.html);writeFileSync(guideFile,value.guide);
  }
  budget.git(['add','--all'],path);budget.git(['commit','--no-verify','-m',`Evolution isolated ${id}`],path);
  return {id,path,commit:budget.git(['rev-parse','HEAD'],path),proposal,generation};
}
function cleanReproduce(budget,out,candidate,baseline) {
  const directory=resolve(out,'clean-reproduction',candidate.id);
  budget.git(['worktree','add','--detach',directory,candidate.commit]);
  const checked=inspectCandidate(budget,directory,baseline);
  return {passed:true,commit:candidate.commit,diffSha256:checked.sha256,metrics:coldMetrics(directory),mode:'fresh Git checkout, no candidate execution',path:directory};
}
export function runCampaign(value) {
  const out=safeOutput(value);if(existsSync(out))throw new Error('OUTPUT_ALREADY_EXISTS');mkdirSync(out,{recursive:true});
  const budget=new Budget(out), integrity={...verifyKernel(),artifacts:artifactManifest()};
  const baseline=budget.git(['rev-parse','HEAD']);
  if(budget.git(['status','--porcelain']))throw new Error('BASELINE_MUST_BE_COMMITTED_AND_CLEAN');
  const environment={os:platform(),release:release(),arch:arch(),node:process.version,dependencies:hash(readFileSync(resolve(root,'sdk/typescript/package-lock.json'))),network:'none in candidate/evaluation',permissions:'bounded-data + Node permission for generation'};
  const versions=json(resolve(root,'docs/published-versions.json'));versions.python=readFileSync(resolve(root,'sdk/python/pyproject.toml'),'utf8').match(/^version\s*=\s*"([^"]+)"/m)[1];
  atomic(resolve(out,'progress.json'),{status:'RUNNING',baseline,startedAt:new Date().toISOString(),legitimate:false});
  try {const state=startCampaign(budget,out,baseline,integrity,environment,versions);atomic(resolve(out,'progress.json'),{status:state.status,legitimate:false});return state;}
  catch(error){atomic(resolve(out,'failure.json'),{status:'FAILED',reason:error.message,baseline,resourceUsage:{subprocesses:budget.processes,wallMs:Date.now()-budget.started},legitimate:false});throw error;}
}
function startCampaign(budget,out,baseline,integrity,environment,versions) {
  const startedAt=new Date().toISOString(),baseMetrics=coldMetrics(root),campaignId='first10-'+baseline.slice(0,12)+'-'+randomBytes(4).toString('hex');
  atomic(resolve(out,'baseline.json'),{campaignId,repository:'https://github.com/stringsofthemind-oss/once',branch:budget.git(['branch','--show-current']),commit:baseline,versions,...integrity,testSuiteVersion:'evolution/1 + existing Once regressions',environment,goal:'Fix objectively observed prerequisite ordering/evidence handoff; strengthen bounded fault generation',ring:[3,4],startingMetric:baseMetrics,timestamp:startedAt});
  atomic(resolve(out,'observations.json'),[
    {kind:'FACT',source:'docs/first10/index.html',observation:'First npx command precedes Node.js 24.15+ prerequisite',metric:baseMetrics.prerequisiteOrderViolations},
    {kind:'FACT',source:'examples/first10/README.md',observation:'No concrete report-reading command',metric:baseMetrics.reportInspectionInstructions},
    {kind:'INFERENCE',observation:'Ordering and evidence handoff may cause cold-reader uncertainty; no human failure established'},
    {kind:'HYPOTHESIS',target:'FIRST10 docs',mechanism:'Reorder existing prerequisite or add read-only evidence instructions',metric:'zero ordering violations or one reproducible report instruction',risks:'Misleading success/identity or fixture claims',ring:3,falsification:'Regression or no structural improvement'}]);
  const m0=validateStrategy(json(resolve(root,'evolution/zone/strategy.json')));
  const m1={version:'M1',operators,casesPerOperator:2};
  const zero=proposalOutput(budget,out,0,m0,[]);
  // A counterfactual schedule only, not approval or activation of M1.
  const proposed=proposalOutput(budget,out,1,m1,[],'counterfactual');
  const candidates=zero.proposals.map(p=>buildCandidate(budget,out,baseline,p,0));
  const ordinaryResult=ordinary(budget,out);
  const evaluation=evaluateStrength(budget,resolve(out,'evaluation'),resolve(root,'sdk/typescript/dist'),zero.cases,proposed.cases);
  verifyArtifacts(integrity.artifacts);
  const state={schemaVersion:1,campaignId,baseline,integrity,environment,versions,startedAt,baseMetrics,status:'AWAITING_HUMAN_TRIAL_APPROVAL',generation:0,lineage:[],knowledge:[],evaluation,ordinaryResult,resourceUsage:{}};
  for(const candidate of candidates) {
    let inspected,reason='',metrics,reproduction;
    try {inspected=inspectCandidate(budget,candidate.path,baseline);metrics=coldMetrics(candidate.path);reproduction=cleanReproduce(budget,out,candidate,baseline);}catch(e){reason=e.message;}
    const strategyImproved=candidate.proposal.ring===4 && evaluation.strength.M1.killed>evaluation.strength.M0.killed && evaluation.strength.M1.operators>evaluation.strength.M0.operators;
    const intendedImprovement=strategyImproved||Boolean(metrics&&(metrics.prerequisiteOrderViolations<baseMetrics.prerequisiteOrderViolations||metrics.reportInspectionInstructions>baseMetrics.reportInspectionInstructions));
    const hardGates={kernelIntegrity:true,protectedPaths:!reason,ordinary:ordinaryResult.passed,properties:evaluation.baseline.passed,stateMachine:evaluation.baseline.passed,holdout:evaluation.holdout.passed,
      adversarial:evaluation.adversarial.passed,mutation:evaluation.strength.dangerousSurvivors.length===0,documentation:Boolean(metrics&&documentationGates(baseMetrics,metrics)),
      noCandidateExecution:true,noCredentials:true,noSelfApproval:true,cleanReproduction:Boolean(reproduction?.passed),resourceLimits:true};
    const eligible=candidate.proposal.ring>=2&&Object.values(hardGates).every(Boolean)&&intendedImprovement;
    const receipt=recordReceipt(out,{schemaVersion:1,campaignId,candidateId:candidate.id,parentCandidate:null,generation:0,baselineCommit:baseline,candidateCommit:candidate.commit,riskRing:candidate.proposal.ring,
      constitution:{version:constitution.version,hash:integrity.constitutionHash},evaluator:{version:integrity.version,hash:integrity.evaluatorHash},
      roles:{proposer:'trusted bounded-data interpreter/1',builder:'trusted fixed edit operators/1',breaker:'independent protected safety/mutation suite/1',coldUser:'structural synthetic observer/1',legitimizer:'kernel admission/1'},
      target:candidate.proposal.ring===4?'bounded adversarial fault generator':'FIRST10 documentation',hypothesis:candidate.proposal.hypothesis,
      filesChanged:inspected?.files??[],diffStatistics:{bytes:inspected?.bytes??0,sha256:inspected?.sha256??null},
      results:{ordinary:ordinaryResult,property:evaluation.baseline,stateMachine:evaluation.baseline,mutation:{total:evaluation.strength.total,killed:evaluation.strength.killed,dangerousSurvivors:evaluation.strength.dangerousSurvivors},holdout:evaluation.holdout,adversarial:evaluation.adversarial,
        coldUser:metrics??{notEvaluated:true},performance:{scope:'machine fixtures only; no human time measurement',generatedCases:candidate.proposal.ring===4?evaluation.strength.M1.cases:evaluation.strength.M0.cases},security:{restrictedData:true,arbitrarySourceAllowed:false},evaluatorTampering:{attempted:candidate.proposal.operation==='tamper',detected:reason.startsWith('PROTECTED_PATH')}},
      hardGates,softMetrics:{baseline:baseMetrics,candidate:metrics??null,strategy:strategyImproved?{M0:evaluation.strength.M0,M1:evaluation.strength.M1}:null},
      decision:eligible?'ELIGIBLE_FOR_HUMAN_PROMOTION':'REJECTED',decisionReason:reason||(!intendedImprovement?'No demonstrated objective improvement':eligible?'Hard gates pass; independently measured bounded objective improves; human decision required':'Hard gate failed'),promotionEligibility:eligible,
      rollback:{target:baseline,origin:candidate.commit,parent:baseline,restore:`git restore --source=${baseline} -- ${inspected?.files.join(' ')??''}`,diffFile:'diffs/'+candidate.id+'.patch'},
      timestamps:{startedAt,completedAt:new Date().toISOString()},environment,cleanReproduction:reproduction??false,provenance:{candidateLanguage:constitution.candidateLanguage,sourceGeneration:zero.strategyVersion}});
    mkdirSync(resolve(out,'diffs'),{recursive:true});writeFileSync(resolve(out,'diffs',candidate.id+'.patch'),inspected?.diff??budget.git(['diff','--binary',baseline,candidate.commit]));
    state.lineage.push({id:candidate.id,parent:null,generation:0,commit:candidate.commit,decision:receipt.decision,receiptHash:receipt.receiptHash,path:candidate.path});
    state.knowledge.push({kind:'derived-lesson',observedFailure:reason||null,rule:candidate.proposal.operation==='tamper'?'Judge edits are rejected before candidate execution':candidate.proposal.ring===4?'Fault breadth must be measured against seeded defects, not self-report':'Document metrics are synthetic, not adoption evidence',confidence:'machine-demonstrated',evidence:receipt.candidateId});
  }
  state.resourceUsage={subprocesses:budget.processes,diskBytes:budget.disk(),wallMs:Date.now()-budget.started};
  atomic(resolve(out,'knowledge.json'),state.knowledge);atomic(resolve(out,'lineage.json'),state.lineage);sealState(out,state);verifyKernel();return state;
}
export function approveTrial(outValue,id,expectedHash) {
  if(!/^g[01]-[a-zA-Z0-9-]+$/.test(id??''))throw new Error('INVALID_CANDIDATE_ID');
  const out=safeOutput(outValue),state=loadState(out),integrity={...verifyKernel(),artifacts:artifactManifest()};
  const receipt=validateReceipt(json(resolve(out,'receipts',id+'.json')));
  if(receipt.receiptHash!==expectedHash||receipt.decision!=='ELIGIBLE_FOR_HUMAN_PROMOTION'||receipt.riskRing!==4||receipt.candidateId!=='g0-strategy-M1')throw new Error('TRIAL_APPROVAL_REJECTED');
  if(state.status!=='AWAITING_HUMAN_TRIAL_APPROVAL')throw new Error('INVALID_CAMPAIGN_STATE');
  if(digest(integrity)!==digest(state.integrity))throw new Error('EVALUATOR_CHANGED');
  verifyArtifacts(state.integrity.artifacts);
  const budget=new Budget(out,{...constitution.limits,subprocesses:constitution.limits.subprocesses-state.resourceUsage.subprocesses,wallMs:constitution.limits.wallMs-state.resourceUsage.wallMs});
  const candidate=state.lineage.find(x=>x.id===id);
  if(!candidate||candidate.receiptHash!==expectedHash||candidate.commit!==receipt.candidateCommit||receipt.campaignId!==state.campaignId||receipt.baselineCommit!==state.baseline||budget.git(['rev-parse','HEAD'],candidate.path)!==receipt.candidateCommit||budget.git(['rev-parse','HEAD'])!==state.baseline||budget.git(['status','--porcelain']))throw new Error('APPROVAL_PROVENANCE_MISMATCH');
  const inspected=inspectCandidate(budget,candidate.path,state.baseline);
  if(inspected.sha256!==receipt.diffStatistics.sha256)throw new Error('TRIAL_CANDIDATE_CHANGED');
  const strategy=validateStrategy(json(resolve(candidate.path,'evolution/zone/strategy.json')));
  atomic(resolve(out,'trial-approval.json'),{candidateId:id,receiptHash:expectedHash,authority:'explicit maintainer command',scope:'isolated next generation only; no production merge',timestamp:new Date().toISOString()});
  state.status='TRIAL_RUNNING';sealState(out,state);
  try {
  const generated=proposalOutput(budget,out,1,strategy,state.knowledge);
  const later=safety(budget,resolve(root,'sdk/typescript/dist'),resolve(out,'generation1-actual'),generated.cases);
  if(!later.passed)throw new Error('LATER_GENERATION_SAFETY_FAILURE');
  const receipts=[];
  for(const proposal of generated.proposals) {
    const built=buildCandidate(budget,out,state.baseline,proposal,1),check=inspectCandidate(budget,built.path,state.baseline),metrics=coldMetrics(built.path),reproduction=cleanReproduce(budget,out,built,state.baseline);
    const original=validateReceipt(json(resolve(out,'receipts/g0-prerequisite-first.json')));
    const eligible=documentationGates(state.baseMetrics,metrics)&&later.passed;
    const receipt2={...original,candidateId:built.id,parentCandidate:id,generation:1,candidateCommit:built.commit,hypothesis:proposal.hypothesis,filesChanged:check.files,diffStatistics:{bytes:check.bytes,sha256:check.sha256},
      results:{...original.results,adversarial:later,coldUser:metrics,security:{restrictedData:true,arbitrarySourceAllowed:false,protectedDiffRechecked:true,reusedSafetyEvidence:'Identical unchanged SDK/test/kernel bytes; full protected baseline results reused',candidateExecution:'none'}},softMetrics:{baseline:state.baseMetrics,candidate:metrics,generatedFaults:generated.cases.length,strategyVersion:generated.strategyVersion},
      decision:eligible?'ELIGIBLE_FOR_HUMAN_PROMOTION':'REJECTED',decisionReason:'Independent protected gates retained; approved trial machinery used; production human gate remains',promotionEligibility:eligible,
      rollback:{target:state.baseline,origin:built.commit,parent:state.baseline,restore:`git restore --source=${state.baseline} -- ${check.files.join(' ')}`,diffFile:'diffs/'+built.id+'.patch'},
      hardGates:{...original.hardGates,documentation:documentationGates(state.baseMetrics,metrics),cleanReproduction:reproduction.passed,adversarial:later.passed},cleanReproduction:reproduction,provenance:{candidateLanguage:constitution.candidateLanguage,sourceGeneration:generated.strategyVersion,approvedReceipt:expectedHash,knowledgeUsed:generated.knowledgeUsed,reusedGatesFrom:original.candidateId,reuseReason:'Candidate only changes interpreted documentation; immutable SDK/kernel and baseline commit match'},timestamps:{startedAt:state.startedAt,completedAt:new Date().toISOString()}};
    delete receipt2.receiptHash;receipts.push(recordReceipt(out,receipt2));writeFileSync(resolve(out,'diffs',built.id+'.patch'),check.diff);
    state.lineage.push({id:built.id,parent:id,generation:1,commit:built.commit,decision:receipt2.decision,receiptHash:receipt2.receiptHash,path:built.path});
  }
  state.status='COMPLETE_HUMAN_PRODUCTION_GATE';state.generation=1;
  state.recursion={demonstrated:state.evaluation.strength.M1.killed>state.evaluation.strength.M0.killed&&generated.strategyVersion==='M1'&&later.passed,
    M0:state.evaluation.strength.M0,M1:state.evaluation.strength.M1,actuallyUsed:{version:generated.strategyVersion,cases:generated.cases.length,operators:new Set(generated.cases.map(x=>x.scenario)).size,passed:later.passed,knowledgeUsed:generated.knowledgeUsed},approvalReceipt:expectedHash,
    scope:'bounded declarative adversarial generator; synthetic metrics, no general self-programming or adoption claim'};
  state.resourceUsage={subprocesses:state.resourceUsage.subprocesses+budget.processes,diskBytes:budget.disk(),wallMs:state.resourceUsage.wallMs+Date.now()-budget.started};
  atomic(resolve(out,'lineage.json'),state.lineage);sealState(out,state);verifyKernel();verifyArtifacts(state.integrity.artifacts);return state;
  } catch(error) {
    state.status='TRIAL_FAILED';state.failure={reason:error.message,legitimate:false,timestamp:new Date().toISOString()};
    state.resourceUsage={...state.resourceUsage,subprocesses:state.resourceUsage.subprocesses+budget.processes,wallMs:state.resourceUsage.wallMs+Date.now()-budget.started};
    sealState(out,state);throw error;
  }
}

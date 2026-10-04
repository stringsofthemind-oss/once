import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { root, operators, atomic, digest, json, verifyKernel, artifactManifest, verifyArtifacts } from './common.mjs';
import { mutations } from './mutations.mjs';

export function seededCases(seed, scenarios=operators, per=1) {
  return scenarios.flatMap((scenario,index)=>Array.from({length:per},(_,n)=>{
    const entropy=createHash('sha256').update(seed+':'+index+':'+n).digest();
    return {id:'intent-'+entropy.subarray(0,8).toString('hex'),amount:1+entropy.readUInt32BE(8)%100000,currency:['GBP','USD','EUR'][entropy[12]%3],scenario};
  }));
}
export function safety(budget,dist,dir,cases) {
  mkdirSync(dir,{recursive:true});atomic(resolve(dir,'cases.json'),cases);
  // The trusted worker has a single fixed restart helper; account for these descendants too.
  budget.processes+=cases.filter(x=>x.scenario==='restart').length;
  const process=budget.run(globalThis.process.execPath,[resolve(root,'evolution/kernel/safety-worker.mjs'),dist,resolve(dir,'state'),resolve(dir,'cases.json')]);
  let report;try {report=JSON.parse(process.stdout.trim());}catch {throw new Error('INVALID_EVALUATOR_OUTPUT');}
  if(!Array.isArray(report.tests)||report.tests.length!==cases.length || !Array.isArray(report.violations) ||
    report.tests.some((test,index)=>test.id!==cases[index].id||test.scenario!==cases[index].scenario||typeof test.passed!=='boolean'||test.entered!==true) ||
    report.passed!==(report.violations.length===0) || report.passed!==report.tests.every(x=>x.passed) || process.status!==(report.passed?0:1) ||
    report.violations.some(x=>x.kind==='INFRASTRUCTURE'))throw new Error('INCOMPLETE_OR_INFRASTRUCTURE_EVALUATION');
  return {...report,exitCode:process.status,completed:true,outputHash:digest(report)};
}
export function evaluateStrength(budget,out,dist,generatedM0,generatedM1) {
  verifyKernel();const trustedArtifacts=artifactManifest();
  const seed=randomBytes(32).toString('hex');
  atomic(resolve(out,'holdout-commitment.json'),{seedSha256:digest(seed),createdAt:new Date().toISOString(),disclosure:'only after evaluations complete'});
  const full=seededCases(seed,operators,2);
  const baseline=safety(budget,dist,resolve(out,'property'),seededCases('public-properties-v1',operators));
  const holdout=safety(budget,dist,resolve(out,'holdout'),full);
  const adversarial=safety(budget,dist,resolve(out,'adversarial'),seededCases(seed+':dynamic',operators));
  const records=[];
  for(const mutation of mutations) {
    const directory=resolve(out,'mutants',mutation.id), copy=resolve(directory,'dist');
    mkdirSync(directory,{recursive:true});cpSync(dist,copy,{recursive:true});
    const file=resolve(copy,mutation.file), source=readFileSync(file,'utf8');
    if(source.split(mutation.from).length!==2)throw new Error('MUTANT_NOT_INSTALLED: '+mutation.id);
    writeFileSync(file,source.replace(mutation.from,mutation.to));
    const syntax=budget.run(process.execPath,['--check',file]);
    if(syntax.status!==0)throw new Error('MUTANT_INFRASTRUCTURE_FAILURE');
    const protectedResult=safety(budget,copy,resolve(directory,'protected'),seededCases(seed+':mutation',operators));
    const m0=safety(budget,copy,resolve(directory,'M0'),generatedM0);
    const m1=safety(budget,copy,resolve(directory,'M1'),generatedM1);
    // Installed, syntactically executable mutants must reach assertions: infrastructure failures are not kills.
    const killed=r=>r.exitCode===1 && r.tests.some(x=>!x.passed&&x.entered) && r.violations.some(x=>x.kind==='SAFETY_ASSERTION');
    records.push({id:mutation.id,installed:true,sourceHash:digest(readFileSync(file,'utf8')),protectedKilled:killed(protectedResult),m0Killed:killed(m0),m1Killed:killed(m1),results:{protected:protectedResult,M0:m0,M1:m1}});
    budget.disk();verifyKernel();verifyArtifacts(trustedArtifacts);
  }
  const strength={total:records.length,killed:records.filter(x=>x.protectedKilled).length,dangerousSurvivors:records.filter(x=>!x.protectedKilled).map(x=>x.id),
    M0:{cases:generatedM0.length,operators:new Set(generatedM0.map(x=>x.scenario)).size,killed:records.filter(x=>x.m0Killed).length},
    M1:{cases:generatedM1.length,operators:new Set(generatedM1.map(x=>x.scenario)).size,killed:records.filter(x=>x.m1Killed).length},records};
  atomic(resolve(out,'holdout-disclosure.json'),{seed,seedSha256:digest(seed),cases:full,reproducibleWith:'seededCases(seed,operators,2)',completedAt:new Date().toISOString()});
  atomic(resolve(out,'evaluation.json'),{baseline,holdout,adversarial,strength});
  verifyKernel();verifyArtifacts(trustedArtifacts);return {baseline,holdout,adversarial,strength};
}
export function ordinary(budget,out) {
  const args=['--test','sdk/typescript/test/first10.test.mjs','sdk/typescript/test/local.test.mjs','sdk/typescript/test/wrap-tool.test.mjs','sdk/typescript/test/local-session.test.mjs','scripts/website-funnel.test.mjs'];
  const result=budget.run(process.execPath,args);
  writeFileSync(resolve(out,'ordinary.log'),result.stdout+result.stderr);
  if(result.status!==0)throw new Error('BASELINE_REGRESSION');
  return {passed:true,command:['node',...args],log:'ordinary.log',sha256:digest(result.stdout+result.stderr)};
}

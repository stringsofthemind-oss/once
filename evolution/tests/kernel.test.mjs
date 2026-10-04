import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { root, Budget, safeOutput, contained, scrubEnvironment, validateStrategy, verifyKernel, constitution, digest, artifactManifest, verifyArtifacts } from '../kernel/common.mjs';
import { approveTrial, inspectCandidate, validateReceipt } from '../kernel/campaign.mjs';
import { coldMetrics, applyDocumentation, evidenceGuide } from '../kernel/docs-evaluator.mjs';
import { seededCases } from '../kernel/evaluate.mjs';

const temp=()=>mkdtempSync(resolve(tmpdir(),'once-evolution-test-'));
test('protected kernel hashes match installed constitution/evaluator',()=>assert(verifyKernel().evaluatorHash));
test('compiled artifact hashes bind execution and evidence reuse',()=>{const manifest=artifactManifest();verifyArtifacts(manifest);const bad={...manifest,'sdk/typescript/dist/local.js':'0'.repeat(64)};assert.throws(()=>verifyArtifacts(bad),/SDK_ARTIFACT_DRIFT/);});
test('path escapes, output within repository and existing links fail closed',()=>{
  assert.throws(()=>contained(root,'../outside'));assert.throws(()=>safeOutput(root));assert.throws(()=>safeOutput(resolve(root,'evolution/outputs')));
  const dir=temp(),target=resolve(dir,'target'),link=resolve(dir,'link');mkdirSync(target);symlinkSync(target,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>safeOutput(link),/OUTPUT_LINK/);
});
test('candidate environment withholds credentials, node options and Git configuration',()=>{
  process.env.ONCE_EVOLUTION_SECRET_FIXTURE='not-a-secret';const env=scrubEnvironment(temp());assert(!Object.hasOwn(env,'ONCE_EVOLUTION_SECRET_FIXTURE'));assert(!Object.hasOwn(env,'NODE_OPTIONS'));assert(!Object.hasOwn(env,'GITHUB_TOKEN'));assert.equal(env.GIT_TERMINAL_PROMPT,'0');delete process.env.ONCE_EVOLUTION_SECRET_FIXTURE;
});
test('bounded candidate language rejects paths, subprocess commands and threshold authority',()=>{
  const m0={version:'M0',operators:['replay'],casesPerOperator:1};assert.deepEqual(validateStrategy(m0),m0);
  for(const value of [{...m0,command:'curl'}, {...m0,operators:['../constitution']},{...m0,operators:['replay','replay']},{...m0,casesPerOperator:999},{...m0,threshold:0}])assert.throws(()=>validateStrategy(value));
});
test('trial ID traversal is rejected before reading any receipt',()=>assert.throws(()=>approveTrial(temp(),'../../private','0'.repeat(64)),/INVALID_CANDIDATE_ID/));
test('permission worker reads exact inputs only and produces real differing fault schedules',()=>{
  const dir=temp(),budget=new Budget(dir),worker=resolve(root,'evolution/kernel/candidate-worker.mjs');
  function run(strategy,label){const input=resolve(dir,label+'.json'),output=resolve(dir,label+'-output.json');writeFileSync(input,JSON.stringify({generation:0,strategy,knowledge:[]}));const result=budget.run(process.execPath,['--permission','--allow-fs-read='+worker,'--allow-fs-read='+input,'--allow-fs-write='+output,worker,input,output],{cwd:dir});return {result,data:existsSync(output)?JSON.parse(readFileSync(output,'utf8')):null};}
  const m0=run({version:'M0',operators:['replay','attempt'],casesPerOperator:2},'M0');assert.equal(m0.result.status,0);assert.equal(m0.data.cases.length,4);
  const bad=run({version:'M1',operators:['exec-shell'],casesPerOperator:1},'bad');assert.notEqual(bad.result.status,0);assert.equal(bad.data,null);
  // A trusted test probe intentionally tries the prohibited read and subprocess.
  const probe=resolve(dir,'probe.mjs');writeFileSync(probe,"import fs from 'node:fs';import cp from 'node:child_process';let denied=0;try{fs.readFileSync(process.argv[2])}catch(e){if(e.code==='ERR_ACCESS_DENIED')denied++}try{cp.spawnSync(process.execPath,['-e','process.exit(0)'])}catch(e){if(e.code==='ERR_ACCESS_DENIED')denied++}console.log(denied)");
  const denied=budget.run(process.execPath,['--permission','--allow-fs-read='+probe,probe,resolve(root,'evolution/constitution/v1.json')]);assert.equal(denied.status,0);assert.equal(denied.stdout.trim(),'2');
});
test('resource limits bound processes, wall time, disk and output',()=>{
  const dir=temp();const budget=new Budget(dir,{...constitution.limits,subprocesses:0});assert.throws(()=>budget.run(process.execPath,['-e','']),/SUBPROCESS_LIMIT/);
  const wall=new Budget(dir,{...constitution.limits,wallMs:1});wall.started-=10;assert.throws(()=>wall.check(),/WALL_LIMIT/);
  writeFileSync(resolve(dir,'large'),'123456789');const disk=new Budget(dir,{...constitution.limits,diskBytes:8});assert.throws(()=>disk.disk(),/DISK_LIMIT/);
  const output=new Budget(temp(),{...constitution.limits,outputBytes:20});assert.throws(()=>output.run(process.execPath,['-e','console.log("x".repeat(10000))']),/SUBPROCESS_FAILURE/);
});
test('holdout seeded replay changes business identity/payload while preserving fault types',()=>{
  assert.deepEqual(seededCases('seed'),seededCases('seed'));assert.notDeepEqual(seededCases('other'),seededCases('seed'));assert.equal(seededCases('seed').length,11);
});
test('FIRST10 bounded docs variants improve different observed metrics; report command really works',()=>{
  const baseline=coldMetrics(root);assert.equal(baseline.prerequisiteOrderViolations,1);assert.equal(baseline.reportInspectionInstructions,0);assert.equal(baseline.safetyWordingPreserved,true);
  const html=readFileSync(resolve(root,'docs/first10/index.html'),'utf8'),guide=readFileSync(resolve(root,'examples/first10/README.md'),'utf8');
  const ordered=applyDocumentation('move-prerequisite',html,guide);assert(ordered.html.indexOf('Node.js 24.15+')<ordered.html.indexOf('npx --yes'));assert.equal(ordered.guide,guide);
  const handoff=applyDocumentation('add-evidence-guide',html,guide);assert.equal(handoff.html,html);assert(handoff.guide.includes(evidenceGuide));
  const dir=resolve(temp(),'path containing spaces');mkdirSync(dir);writeFileSync(resolve(dir,'report.json'),JSON.stringify({scenarios:{'lost-ack':{initialStatus:'UNKNOWN',finalStatus:'CONFIRMED'}}}));
  const code="const fs=require('node:fs'),p=require('node:path');console.log(fs.readFileSync(p.join(process.argv[1],'report.json'),'utf8'))";
  const budget=new Budget(temp());const result=budget.run(process.execPath,['-e',code,dir]);assert.equal(result.status,0);assert.match(result.stdout,/UNKNOWN/);
  const missing=budget.run(process.execPath,['-e',code,dir+'-missing']);assert.notEqual(missing.status,0);
});
test('candidate patch admission rejects test deletion, hash changes, CI, fake outputs and links',()=>{
  const dir=temp(),budget=new Budget(dir);assert.equal(budget.run('git',['init',dir]).status,0);
  mkdirSync(resolve(dir,'docs/first10'),{recursive:true});writeFileSync(resolve(dir,'docs/first10/index.html'),'baseline');writeFileSync(resolve(dir,'protected-test.mjs'),'assert(true)');budget.git(['add','--all'],dir);budget.git(['commit','-m','baseline'],dir);const baseline=budget.git(['rev-parse','HEAD'],dir);
  writeFileSync(resolve(dir,'protected-test.mjs'),'assert(false)');budget.git(['add','--all'],dir);budget.git(['commit','-m','bad'],dir);assert.throws(()=>inspectCandidate(budget,dir,baseline),/PROTECTED_PATH/);
  writeFileSync(resolve(dir,'untracked.json'),'fake output');assert.throws(()=>inspectCandidate(budget,dir,baseline),/UNCOMMITTED/);
});
test('every evaluator-gaming surface fails protected-path admission',()=>{
  const dir=temp(),budget=new Budget(dir);assert.equal(budget.run('git',['init',dir]).status,0);writeFileSync(resolve(dir,'baseline.txt'),'trusted');budget.git(['add','--all'],dir);budget.git(['commit','-m','baseline'],dir);const baseline=budget.git(['rev-parse','HEAD'],dir);
  const attacks=[
    ['evolution/tests/property.test.mjs','test.skip()'],['evolution/kernel/evaluate.mjs','threshold=0; disableMutation=true'],
    ['evolution/constitution/v1.json','UNKNOWN permits retry'],['evolution/constitution/protected-hashes.json','rewritten hashes'],
    ['evolution/kernel/campaign.mjs','promote without approval'],['evolution/holdouts/private.json','remove failing fixture'],
    ['evolution/receipts/fake.json','PASS without execution'],['.github/workflows/evolution-ci.yml','skip tests'],
    ['sdk/typescript/src/local.ts','return invented success'],['benchmarks/fake.json','fabricated timings']];
  for(const [file,content] of attacks){const target=resolve(dir,file);mkdirSync(resolve(target,'..'),{recursive:true});writeFileSync(target,content);budget.git(['add','--all'],dir);budget.git(['commit','-m','controlled attack'],dir);assert.throws(()=>inspectCandidate(budget,dir,baseline),/PROTECTED_PATH/);}
});

import assert from 'node:assert/strict';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const self = fileURLToPath(import.meta.url);
const [dist, sandbox, input, childMode] = process.argv.slice(2);
const allowed = new Set(['replay','conflict','unknown','absent','unavailable','missing-result','corrupt-receipt','concurrency','restart','attempt','omit-field']);
const tests = [], violations = [], counts = {};
function journal(file) { return existsSync(file) ? readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)) : []; }
function write(file, effect) {
  const fd = openSync(file,'a');
  try { appendFileSync(fd,JSON.stringify(effect)+'\n'); fsyncSync(fd); } finally { closeSync(fd); }
}
function query(dbFile, sql, ...args) { const db = new DatabaseSync(dbFile); try { return db.prepare(sql).get(...args); } finally { db.close(); } }
function change(dbFile, sql, ...args) { const db = new DatabaseSync(dbFile); try { return db.prepare(sql).run(...args); } finally { db.close(); } }
async function outcome(fn) { try { return {ok:true,value:await fn()}; } catch(e) { return {ok:false,code:e.code,message:e.message}; } }
function blocked(result, code) { assert.equal(result.ok,false,'unsafe successful response'); assert.equal(result.code,code); }

async function runCase(c, index, sdk) {
  assert(allowed.has(c.scenario),'unknown scenario');
  assert.equal(typeof c.id,'string'); assert(c.id.trim());
  assert(Number.isFinite(c.amount)); assert.equal(typeof c.currency,'string');
  const dir = path.join(sandbox,`case-${index}`); mkdirSync(dir,{recursive:true});
  const statePath=path.join(dir,'state.sqlite'), provider=path.join(dir,'provider.jsonl');
  assert(!existsSync(statePath) && !existsSync(provider),'sandbox must be fresh');
  const observations={entered:false,writes:0,journal:provider,observedStates:[],observedCounts:[]};counts[`${index}:${c.id}`]=observations;
  const effect={id:c.id,amount:c.amount,currency:c.currency};
  const receipt=e=>({providerId:`effect-${journal(provider).length}`,id:e.id,amount:e.amount,currency:e.currency});
  const operation=async e=>{ observations.entered=true;const r=receipt(e); write(provider,{effect:e,result:r}); if(['unknown','absent','unavailable','missing-result','restart'].includes(c.scenario)) throw new Error('lost acknowledgement'); return r; };
  const options={id:e=>e.id,payload:e=>({amount:e.amount,currency:e.currency}),statePath,leaseMs:1000};
  const wrap=(reconcile)=>sdk.protectLocal(operation,{...options,...(reconcile ? {reconcile}: {})});
  const size=()=>{const n=journal(provider).length;observations.observedCounts.push(n);observations.writes=n;return n;};
  const state=()=>{const value=query(statePath,'SELECT state FROM local_operations WHERE id=?',c.id)?.state;observations.observedStates.push(value);return value;};
  const truth=()=>({state:'CONFIRMED',result:journal(provider)[0].result});
  if(c.scenario==='concurrency') {
    let release, started; const gate=new Promise(r=>release=r), entered=new Promise(r=>started=r);
    const f=sdk.protectLocal(async e=>{observations.entered=true;const r=receipt(e);write(provider,{effect:e,result:r});started();await gate;return r;},options);
    const first=outcome(()=>f(effect)); await entered;
    const second=await outcome(()=>f(effect)); release(); const result=await first;
    blocked(second,'IN_FLIGHT');assert(result.ok);assert.equal(size(),1);assert.equal(state(),'CONFIRMED');
  } else if(['unknown','absent','unavailable','missing-result','restart'].includes(c.scenario)) {
    blocked(await outcome(()=>wrap()(effect)),'UNKNOWN');assert.equal(size(),1);assert.equal(state(),'UNKNOWN');
    blocked(await outcome(()=>wrap()(effect)),'UNKNOWN');assert.equal(size(),1);
    blocked(await outcome(()=>wrap()({...effect,amount:effect.amount+1})),'CONFLICT');
    if(c.scenario==='restart') {
      const config={effect,statePath,provider};
      const child=spawnSync(process.execPath,[self,dist,sandbox,JSON.stringify(config),'--child'],{encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}});
      assert.equal(child.status,0,child.stderr); const response=JSON.parse(child.stdout);blocked(response,'UNKNOWN');assert.equal(size(),1);
    }
    if(['unknown','unavailable'].includes(c.scenario)) {
      blocked(await outcome(()=>wrap(()=>{throw new Error('lookup unavailable');})(effect)),'UNKNOWN');assert.equal(state(),'UNKNOWN');
      blocked(await outcome(()=>wrap(()=>({state:'UNKNOWN'}))(effect)),'UNKNOWN');assert.equal(state(),'UNKNOWN');
    }
    if(['unknown','absent'].includes(c.scenario)) {
      blocked(await outcome(()=>wrap(()=>({state:'ABSENT'}))(effect)),'UNKNOWN');assert.equal(state(),'UNKNOWN');assert.equal(size(),1);
    }
    if(['unknown','missing-result'].includes(c.scenario)) {
      blocked(await outcome(()=>wrap(()=>({state:'CONFIRMED'}))(effect)),'INVALID_TRUTH');assert.equal(state(),'UNKNOWN');
    }
    const recovered=await wrap(truth)(effect);assert.deepEqual(recovered,journal(provider)[0].result);assert.equal(state(),'CONFIRMED');
    assert.deepEqual(await wrap()(effect),recovered);assert.equal(size(),1);
  } else {
    const result=await wrap()(effect);assert.deepEqual(result,journal(provider)[0].result);assert.equal(size(),1);assert.equal(state(),'CONFIRMED');
    assert.deepEqual(await wrap()(effect),result);assert.equal(size(),1);
    if(c.scenario==='attempt') {
      assert.deepEqual(await wrap()({...effect,attempt:2}),result);assert.equal(size(),1);
      const reordered=sdk.protectLocal(operation,{...options,payload:e=>({currency:e.currency,amount:e.amount})});
      assert.deepEqual(await reordered({...effect,transport:{attempt:99,verbosity:'verbose'}}),result);assert.equal(size(),1);
    }
    if(c.scenario==='conflict')blocked(await outcome(()=>wrap()({...effect,amount:effect.amount+1})),'CONFLICT');
    if(c.scenario==='omit-field')blocked(await outcome(()=>wrap()({...effect,currency:effect.currency==='USD'?'EUR':'USD'})),'CONFLICT');assert.equal(size(),1);
    if(c.scenario==='corrupt-receipt') {
      change(statePath,'UPDATE local_operations SET result_json=? WHERE id=?',JSON.stringify({hasValue:true,value:result,extra:'corrupt'}),c.id);
      blocked(await outcome(()=>wrap()(effect)),'STATE_UNAVAILABLE');assert.equal(size(),1);
    }
  }
  // A genuinely different developer identity authorizes its own effect.
  if(!['unknown','absent','unavailable','missing-result','restart'].includes(c.scenario)) {
    await wrap()({...effect,id:effect.id+':new'});assert.equal(size(),2);
  }
  size();return observations;
}

try {
  assert(path.isAbsolute(dist) && path.isAbsolute(sandbox),'absolute dist and sandbox required');
  const sdk=await import(pathToFileURL(path.join(dist,'local.js')).href);
  if(childMode==='--child') {
    const c=JSON.parse(input);
    const result=await outcome(()=>sdk.protectLocal(async e=>{write(c.provider,{effect:e,result:{unsafe:true}});return {unsafe:true};},{id:e=>e.id,payload:e=>({amount:e.amount,currency:e.currency}),statePath:c.statePath})(c.effect));
    console.log(JSON.stringify(result));
  } else {
    assert(path.isAbsolute(input),'absolute cases file required');const cases=JSON.parse(readFileSync(input,'utf8'));assert(Array.isArray(cases)&&cases.length>0);
    mkdirSync(sandbox,{recursive:true});
    for(let i=0;i<cases.length;i++) { try { const observation=await runCase(cases[i],i,sdk);tests.push({id:cases[i].id,scenario:cases[i].scenario,passed:true,...observation}); } catch(e) { const observation=counts[`${i}:${cases[i].id}`]??{entered:false};const provider=path.join(sandbox,`case-${i}`,'provider.jsonl');observation.writes=journal(provider).length;tests.push({id:cases[i].id,scenario:cases[i].scenario,passed:false,...observation});violations.push({id:cases[i].id,scenario:cases[i].scenario,kind:e.code==='ERR_ASSERTION'&&observation.entered?'SAFETY_ASSERTION':'INFRASTRUCTURE',entered:observation.entered,message:e.message});counts[`${i}:${cases[i].id}`]=observation; } }
    console.log(JSON.stringify({passed:violations.length===0,tests,violations,counts}));if(violations.length)process.exitCode=1;
  }
} catch(e) { console.log(JSON.stringify({passed:false,tests,violations:[...violations,{message:e.message}],counts}));process.exitCode=1; }

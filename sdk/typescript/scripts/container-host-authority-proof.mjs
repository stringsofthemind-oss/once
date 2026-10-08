// Disposable CI fixtures only. Two Linux network namespaces on ONE runner.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
const prefix = `once-${process.pid}`, net = `${prefix}-net`, root = resolve('.');
const names = ['execution','continuity','provider','host-a','host-b'].map(x => `${prefix}-${x}`);
function docker(...args) { return execFileSync('docker',args,{ encoding:'utf8',timeout:120000,stdio:['pipe','pipe','pipe'] }).trim(); }
const evidence=[];
let pool, witnessPool;
const pause = ms => new Promise(r=>setTimeout(r,ms));
function worker(host,mode,id) {
  try { return JSON.parse(docker('exec',`${prefix}-${host}`,'node','test/container-authority-worker.mjs',mode,id).split('\n').at(-1)); }
  catch (e) { if (mode==='crash' && e.status===73) return {status:'CRASHED'}; throw e; }
}
function record(name, result) { evidence.push({ name,...result }); console.log(`${name}: ${result.status}`); }
try {
  docker('network','create',net);
  for (const [alias,port] of [['execution',55441],['continuity',55442]]) {
    docker('run','-d','--name',`${prefix}-${alias}`,'--network',net,'--network-alias',alias,'-p',`127.0.0.1:${port}:5432`,'-e','POSTGRES_USER=once','-e','POSTGRES_PASSWORD=fixture','-e','POSTGRES_DB=postgres','postgres:18.4');
  }
  for (const alias of ['provider','host-a','host-b']) docker('run','-d','--name',`${prefix}-${alias}`,'--network',net,'--network-alias',alias,'-v',`${root}:/app:ro`,'-w','/app','node:24.15.0',...(alias==='provider'?['node','test/container-provider.mjs']:['node','-e','setInterval(()=>{},1000)']));
  pool = new pg.Pool({connectionString:'postgresql://once:fixture@127.0.0.1:55441/postgres'});
  witnessPool = new pg.Pool({connectionString:'postgresql://once:fixture@127.0.0.1:55442/postgres'});
  for (const p of [pool,witnessPool]) p.on('error', () => { evidence.push({ name: 'injected-idle-pool-disconnect', status: 'OBSERVED' }); });
  for (const p of [pool,witnessPool]) { for (let i=0;;i++) { try {await p.query('SELECT 1');break;} catch(e) {if(i===30)throw e;await pause(1000);} } }
  await pool.query(readFileSync('sql/execution-authority-v1.sql','utf8'));
  await witnessPool.query(readFileSync('sql/continuity-witness-v1.sql','utf8'));
  await pool.query("INSERT INTO once_execution.authorities VALUES('container-authority',1,'g1',1,0)");
  await witnessPool.query("INSERT INTO once_continuity.metadata VALUES(true,'container-witness',1); INSERT INTO once_continuity.checkpoints VALUES('container-authority','g1',1,0)");
  evidence.push({scope:'Two isolated Linux container hosts on one CI runner; separate PostgreSQL containers. No physical-host, regional, production or real-provider claim.',hosts:names.map(n=>({name:n,ip:docker('inspect','--format',`{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}`,n)}))});
  // Race execs asynchronously so both hosts contend for the same identity.
  const { execFile } = await import('node:child_process');
  const racing = host => new Promise((resolve,reject)=>execFile('docker',['exec',`${prefix}-${host}`,'node','test/container-authority-worker.mjs','normal','race'],{timeout:30000},(e,out)=>e?reject(e):resolve(JSON.parse(out.trim().split('\n').at(-1)))));
  const winners = await Promise.all([racing('host-a'),racing('host-b')]);
  assert.ok(winners.some(x=>x.status==='CONFIRMED')); assert.ok(winners.every(x=>['CONFIRMED','IN_FLIGHT'].includes(x.status)));
  record('two-host-reservation',{status:'PASS',outcomes:winners});
  assert.equal(worker('host-b','normal','race').status,'CONFIRMED');
  assert.equal(worker('host-b','conflict','race').status,'CONFLICT');
  assert.equal(worker('host-a','crash','crash').status,'CRASHED');
  assert.equal(worker('host-b','normal','crash').status,'IN_FLIGHT');
  // Lease is intentionally not waited out: reconcile cannot clear an active claim.
  await pool.query("UPDATE once_execution.operations SET lease_until=0 WHERE id='crash'"); // explicit fixture fault injection
  assert.equal(worker('host-b','normal','crash').status,'UNKNOWN');
  assert.equal(worker('host-b','reconcile','crash').status,'CONFIRMED');
  record('crashed-host-provider-readback',{status:'PASS'});
  docker('network','disconnect',net,`${prefix}-host-a`);
  assert.equal(worker('host-a','normal','partition').status,'STATE_UNAVAILABLE');
  assert.equal(worker('host-b','normal','race').status,'CONFIRMED');
  docker('network','connect','--alias','host-a',net,`${prefix}-host-a`);
  record('host-network-partition',{status:'PASS'});
  docker('stop',`${prefix}-continuity`);
  assert.equal(worker('host-a','normal','witness-outage').status,'CONTINUITY_UNAVAILABLE');
  docker('start',`${prefix}-continuity`); await pause(2000);
  docker('restart',`${prefix}-execution`); await pause(2000);
  assert.equal(worker('host-b','normal','race').status,'CONFIRMED');
  record('authority-restarts-and-witness-outage',{status:'PASS'});
  // A verified matching snapshot is retained BEFORE deliberately rolling execution state back.
  const snapshot=docker('exec',`${prefix}-execution`,'pg_dump','-U','once','--schema=once_execution','--data-only','--column-inserts','postgres');
  await pool.query("DELETE FROM once_execution.operations; UPDATE once_execution.authorities SET revision=0");
  assert.equal(worker('host-b','normal','after-rollback').status,'CONTINUITY_LOST');
  // Recovery restores the original complete matching history, without touching witness.
  await pool.query('DELETE FROM once_execution.authorities');
  execFileSync('docker',['exec','-i',`${prefix}-execution`,'psql','-U','once','-v','ON_ERROR_STOP=1','postgres'],{input:snapshot,encoding:'utf8',timeout:30000});
  assert.equal(worker('host-a','normal','crash').status,'CONFIRMED');
  record('rollback-denial-and-complete-history-recovery',{status:'PASS'});
  // Read journal as JSON explicitly (console inspection output isn't proof input).
} finally {
  if(pool)await pool.end(); if(witnessPool)await witnessPool.end();
  mkdirSync('container-evidence',{recursive:true});
  try { writeFileSync('container-evidence/provider-journal.jsonl',docker('exec',`${prefix}-provider`,'cat','/tmp/provider.jsonl')+'\n'); } catch {}
  writeFileSync('container-evidence/host-proof.json',JSON.stringify(evidence,null,2));
  for(const name of names) {try{docker('rm','-f','-v',name);}catch{}}
  try{docker('network','rm',net);}catch{}
}
const journal=readFileSync('container-evidence/provider-journal.jsonl','utf8').trim().split('\n').map(JSON.parse);
assert.equal(journal.length,2); assert.equal(new Set(journal.map(x=>x.id)).size,2);
console.log('PASS: independently retained provider journal: 2 effects, 2 identities, maximum 1 each');

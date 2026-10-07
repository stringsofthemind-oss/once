// Explicit operator harness. Real provider writes; NEVER runs during local tests.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [flag, bundlePath, configPath, taskRef, proofPath, rawFlag] = process.argv.slice(2);
if(flag!=='--allow-disposable-provider-effects'||![bundlePath,configPath,proofPath].every(x=>x&&path.isAbsolute(x))||!taskRef)throw Error('Explicit disposable effects, bundle/config/output paths and one provisioned taskRef required.');
if(rawFlag!==undefined&&rawFlag!=='--raw-bypass-control')throw Error('Unsupported operator control.');
const config=JSON.parse(readFileSync(configPath,'utf8'));
assert.ok(config.faultControlPath,'Dedicated operator-only control file required.');
const operationId=config.intents[taskRef]; assert.ok(operationId);
const db=new DatabaseSync(config.statePath,{readOnly:true});
assert.equal(db.prepare('SELECT id FROM local_operations WHERE id=?').get(operationId),undefined,'Use a genuinely NEW operator-provisioned canary intent. Never reset existing history.');db.close();
const runtime=path.join(bundlePath,'plugins','once','runtime');
const require=createRequire(path.join(runtime,'package.json'));
const load=async name=>import(pathToFileURL(require.resolve(name)).href);
const {Client}=await load('@modelcontextprotocol/client');
const {StdioClientTransport}=await load('@modelcontextprotocol/client/stdio');
const token=readFileSync(config.tokenPath,'utf8').trim();
const base=`https://api.github.com/repos/${config.authority.owner}/${config.authority.repo}`;
// Independent direct read client: no Once receipts or local provider log used.
const snapshot=async()=>{
 const issues=[];
 for(let page=1;page<=100;page++){
  const response=await fetch(`${base}/issues?state=all&per_page=100&page=${page}`,{redirect:'error',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'},signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,200);const values=await response.json();assert.ok(Array.isArray(values));
  issues.push(...values.filter(x=>!x.pull_request&&x.body?.includes(`<!-- once-correlation:${operationId}:`)).map(x=>({id:x.id,number:x.number,url:x.html_url,title:x.title,body:x.body})));
  if(!(response.headers.get('link')??'').includes('rel="next"')&&values.length<100)return issues;
 }throw Error('Independent count incomplete.');
};
assert.equal((await snapshot()).length,0,'Canary correlation already exists; do not submit.');
const controls=value=>writeFileSync(config.faultControlPath,JSON.stringify(value),{flush:true});
controls({loseNextAcknowledgement:true,lookupEnabled:false});
const client=new Client({name:'real-provider-canary-operator',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(runtime,'node_modules','@once-agent','mcp','dist','github-issue-host.js')],env:{ONCE_GITHUB_CONFIG:configPath},stderr:'pipe'}));
const input={taskRef,title:'Once disposable export-button canary',body:'Disposable tracking issue: clicking Export produces no download.'};
const proof={evidenceTier:'REAL GitHub provider canary via operator MCP client; NOT GPT-6.1 installed routing',taskRef,operationId,scenarios:[]};
const invoke=async(label,args,expected)=>{
 const response=await client.callTool({name:'once_create_github_issue',arguments:args});const outcome=response.structuredContent;
 assert.equal(outcome.status,expected);const observed=await snapshot();assert.equal(observed.length,1);
 proof.scenarios.push({label,status:outcome.status,providerIssues:observed});
 writeFileSync(proofPath,JSON.stringify(proof,null,2));return outcome;
};
try{
 await invoke('lost acknowledgement',input,'UNKNOWN');
 await invoke('blocked retry',input,'UNKNOWN');
 controls({loseNextAcknowledgement:false,lookupEnabled:true});
 const confirmed=await invoke('authoritative recovery',input,'CONFIRMED');
 assert.deepEqual(await invoke('retained replay',input,'CONFIRMED'),confirmed);
 await invoke('changed title conflict',{...input,title:'Changed title'},'CONFLICT');
 if(rawFlag){
  const original=(await snapshot())[0];
  for(let i=0;i<2;i++){
   const response=await fetch(base+'/issues',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2026-03-10'},body:JSON.stringify({title:original.title,body:original.body}),signal:AbortSignal.timeout(20000)});
   assert.equal(response.status,201);await response.json();
  }
  const observed=await snapshot();assert.equal(observed.length,3);
  proof.rawBypassControl={extraRealIssues:2,providerIssues:observed};writeFileSync(proofPath,JSON.stringify(proof,null,2));
 }
 console.log('REAL GitHub canary: '+(rawFlag?'three issues including two explicit raw bypass controls':'one independently counted issue')+'. GPT routing remains untested.');
}finally{await client.close();}

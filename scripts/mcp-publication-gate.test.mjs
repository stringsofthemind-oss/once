import assert from 'node:assert/strict';
import test from 'node:test';
import { publicationAllowed } from './mcp-publication-gate.mjs';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
const before='a'.repeat(40), after='b'.repeat(40);
const versions=version=>({package:version,manifest:version,registryPackage:version});
const push={eventName:'push',ref:'refs/heads/main',before,after,head:after,readVersions:()=>versions('0.1.5')};
test('PR never reads release comparison and remains validation-only',()=>assert.equal(publicationAllowed({eventName:'pull_request',readVersions:()=>{throw Error('must not read');}}),false));
test('main push unchanged version blocks publication',()=>assert.equal(publicationAllowed(push),false));
test('main push changed aligned version is eligible',()=>assert.equal(publicationAllowed({...push,readVersions:rev=>versions(rev===before?'0.1.5':'0.1.6')}),true));
test('manual dispatch preserves intentional path',()=>assert.equal(publicationAllowed({eventName:'workflow_dispatch'}),true));
test('missing previous revision blocks',()=>assert.throws(()=>publicationAllowed({...push,before:undefined})));
test('unresolvable previous object blocks',()=>assert.throws(()=>publicationAllowed({...push,readVersions:()=>{throw Error('missing object');}})));
test('zero initial push and malformed revision block',()=>{for(const value of ['0'.repeat(40),'main; command'])assert.throws(()=>publicationAllowed({...push,before:value}));});
test('checkout mismatch blocks',()=>assert.throws(()=>publicationAllowed({...push,head:before})));
test('incompatible historical or current metadata blocks',()=>assert.throws(()=>publicationAllowed({...push,readVersions:()=>({...versions('0.1.5'),manifest:'0.1.6'})})));
test('non-main and unsupported events block',()=>{assert.equal(publicationAllowed({...push,ref:'refs/heads/feature'}),false);assert.equal(publicationAllowed({...push,eventName:'schedule'}),false);});
test('workflow wires fail-closed gate output before credentials',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/mcp-registry-publish.yml',import.meta.url),'utf8');
 assert.match(workflow,/publish_allowed: \$\{\{ steps\.publication-gate\.outputs\.publish_allowed \}\}/);
 assert.match(workflow,/publish:\s*\n\s*if: needs\.validate\.outputs\.publish_allowed == 'true'/);
 assert.match(workflow,/fetch-depth: 0/);
});
test('real CLI emits blocked output on missing comparison and PR, allows manual dispatch',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'once-release-gate-'));
 try{
  const eventPath=path.join(dir,'event.json'),output=path.join(dir,'output');writeFileSync(eventPath,'{}');
  for(const [eventName,expectedStatus,expected] of [['pull_request',0,false],['workflow_dispatch',0,true],['push',1,false]]){
   writeFileSync(output,'');const result=spawnSync(process.execPath,[fileURLToPath(new URL('./mcp-publication-gate.mjs',import.meta.url))],{env:{...process.env,GITHUB_EVENT_NAME:eventName,GITHUB_REF:'refs/heads/main',GITHUB_EVENT_PATH:eventPath,GITHUB_OUTPUT:output},encoding:'utf8',windowsHide:true});
   assert.equal(result.status,expectedStatus,result.stderr);assert.equal(readFileSync(output,'utf8').trim().split('\n').at(-1),`publish_allowed=${expected}`);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const bundle=process.argv[2];assert.ok(bundle&&path.isAbsolute(bundle));
const plugin=path.join(bundle,'plugins','once');
const read=name=>JSON.parse(readFileSync(path.join(plugin,name),'utf8'));
assert.equal(read('plugin.json').name,'once');assert.equal(read('plugin.json').version,'0.1.2');
assert.deepEqual(read('.mcp.json').mcpServers.once.env_vars,['ONCE_GITHUB_CONFIG']);
const launcher=readFileSync(path.join(plugin,'scripts','once-github-local.cjs'),'utf8');
assert.equal(launcher.includes('npx'),true); // Only the explicit "No npx fallback" comment.
assert.equal(/spawn\([^\n]*npx/.test(launcher),false);
const runtime=path.join(plugin,'runtime','package.json');
const require=createRequire(runtime);
const sdk=JSON.parse(readFileSync(path.join(plugin,'runtime','node_modules','@once-agent','sdk','package.json'),'utf8'));
assert.equal(sdk.version,'0.1.25');
const stagedPackage = JSON.parse(readFileSync(path.join(bundle, 'private-package', 'package.json'), 'utf8'));
assert.equal(stagedPackage.private, true);
assert.ok(stagedPackage.exports['./github-issue']);
const runtimeRoot = path.join(plugin, 'runtime');
const testRoot = path.join(runtimeRoot, 'test');
assert.equal(existsSync(testRoot), false);
try {
 cpSync(fileURLToPath(new URL('../mcp/test', import.meta.url)), testRoot, { recursive: true });
 const result = spawnSync(process.execPath, ['--test', 'test/github-issue.test.mjs'], { cwd: runtimeRoot, encoding: 'utf8', windowsHide: true });
 assert.equal(result.status, 0, result.stdout + result.stderr);
 console.log(result.stdout);
} finally { rmSync(testRoot, { recursive: true, force: true }); }
const {openExistingLedger}=await import(pathToFileURL(path.join(plugin,'runtime','node_modules','@once-agent','mcp','dist','existing-ledger.js')).href);
const dir=mkdtempSync(path.join(os.tmpdir(),'once-private-install-'));
try{
 const statePath=path.join(dir,'operations.sqlite');
 const provision=path.join(plugin,'scripts','provision-private-github-ledger.mjs');
 const run=()=>spawnSync(process.execPath,[provision,'--explicitly-new-ledger',statePath,runtime],{encoding:'utf8',windowsHide:true});
 assert.equal(run().status,0);assert.equal(run().status,1,'Provisioning must refuse every existing file.');
 const ledger=await openExistingLedger(statePath);ledger.assertValid();ledger.close();
 const absent=path.join(dir,'missing.sqlite');await assert.rejects(openExistingLedger(absent));assert.equal(existsSync(absent),false);
 const bad=spawnSync(process.execPath,[path.join(plugin,'scripts','once-github-local.cjs')],{encoding:'utf8',windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}});
 assert.equal(bad.status,1);assert.equal(bad.stdout,'');assert.match(bad.stderr,/cannot start/);
 const configPath=path.join(dir,'host-config.json');
 writeFileSync(configPath,JSON.stringify({statePath,tokenPath:path.join(plugin,'README.md'),authority:{userId:1,ownerId:1,repositoryId:2,owner:'canary',repo:'disposable'},intents:{'BUG-17':'canary-operation'}}));
 const forbidden=spawnSync(process.execPath,[path.join(plugin,'scripts','once-github-local.cjs')],{encoding:'utf8',windowsHide:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,ONCE_GITHUB_CONFIG:configPath}});
 assert.equal(forbidden.status,1);assert.equal(forbidden.stdout,'');assert.match(forbidden.stderr,/cannot start/);
 console.log('PRIVATE INSTALLED BUNDLE: PASS (packaged SDK, fresh provisioning, existing-file refusal, missing-state refusal, actual launcher fail-closed, plugin-resident credential rejection). No GitHub mutation or GPT trace.');
}finally{rmSync(dir,{recursive:true,force:true});}

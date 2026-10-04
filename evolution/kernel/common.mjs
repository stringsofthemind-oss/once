import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, sep, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const constitution = JSON.parse(readFileSync(resolve(root,'evolution/constitution/v1.json'),'utf8'));
export const hash = data => createHash('sha256').update(data).digest('hex');
export const canonical = value => JSON.stringify(normalize(value));
function normalize(value){if(Array.isArray(value))return value.map(normalize);if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalize(value[k])]));return value;}
export const digest = value => hash(canonical(value));
export const json = file => JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export function atomic(file,value) {
  mkdirSync(dirname(file),{recursive:true});
  const temporary = file+'.'+randomBytes(8).toString('hex')+'.tmp';
  writeFileSync(temporary, JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
  renameSync(temporary,file);
}
export function contained(base, value) {
  const target=resolve(base,value); const rel=relative(base,target);
  if (!rel || rel.startsWith('..'+sep) || rel==='..' || isAbsolute(rel)) throw new Error('PATH_ESCAPE');
  return target;
}
export function safeOutput(value) {
  const target=resolve(value); const rel=relative(root,target);
  if (!rel || (!rel.startsWith('..'+sep) && rel!=='..' && !isAbsolute(rel))) throw new Error('OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
  let cursor=target;
  for (;;) { try { if(lstatSync(cursor).isSymbolicLink() || realpathSync(cursor).toLowerCase()!==cursor.toLowerCase()) throw new Error('OUTPUT_LINK'); } catch(e) {if(e.code!=='ENOENT')throw e;}
    const parent=dirname(cursor); if(parent===cursor)break; cursor=parent;
  }
  return target;
}
export function scrubEnvironment(home) {
  return { PATH:process.env.PATH ?? '', SystemRoot:process.env.SystemRoot ?? '', WINDIR:process.env.WINDIR ?? '',
    TEMP:home,TMP:home,TMPDIR:home,HOME:home,USERPROFILE:home, LANG:'C.UTF-8',
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:resolve(home,'empty-gitconfig'),GIT_TERMINAL_PROMPT:'0',
    NODE_NO_WARNINGS:'1',GIT_AUTHOR_NAME:'Once Evolution fixture',GIT_AUTHOR_EMAIL:'evolution@example.invalid',GIT_COMMITTER_NAME:'Once Evolution fixture',GIT_COMMITTER_EMAIL:'evolution@example.invalid'};
}
export class Budget {
  constructor(out, limits=constitution.limits){this.out=out;this.limits=limits;this.started=Date.now();this.processes=0;}
  check() {if(Date.now()-this.started>this.limits.wallMs)throw new Error('WALL_LIMIT');if(this.processes>this.limits.subprocesses)throw new Error('SUBPROCESS_LIMIT');}
  run(command,args,options={}) {
    this.processes++; this.check();
    const result=spawnSync(command,args,{cwd:root,encoding:'utf8',shell:false,timeout:Math.min(120000,this.limits.wallMs-(Date.now()-this.started)),maxBuffer:this.limits.outputBytes,env:scrubEnvironment(this.out),...options});
    if(result.error)throw new Error('SUBPROCESS_FAILURE: '+result.error.code);
    return {status:result.status,stdout:result.stdout??'',stderr:result.stderr??''};
  }
  git(args,cwd=root) {
    const allowed=['rev-parse','show','diff','status','ls-files','worktree','add','commit','branch'];
    if(!allowed.includes(args[0]))throw new Error('COMMAND_NOT_ALLOWED');
    const result=this.run('git',['-c','core.hooksPath='+resolve(this.out,'empty-hooks'),'-c','credential.helper=',
      '-c','core.autocrlf='+(process.platform==='win32'?'true':'false'),...args],{cwd});
    if(result.status!==0)throw new Error('GIT_FAILURE: '+result.stderr);
    return result.stdout.trim();
  }
  disk() {
    let total=0; const visit=dir=>{for(const name of readdirSync(dir)){const p=resolve(dir,name),s=lstatSync(p);if(s.isSymbolicLink())throw new Error('OUTPUT_LINK'); if(s.isDirectory())visit(p);else total+=s.size;if(total>this.limits.diskBytes)throw new Error('DISK_LIMIT');}};
    visit(this.out); this.check(); return total;
  }
}
export function verifyKernel() {
  const manifest=json(resolve(root,'evolution/constitution/protected-hashes.json'));
  for(const [file,expected] of Object.entries(manifest.files)) {
    const p=contained(root,file); if(lstatSync(p).isSymbolicLink())throw new Error('PROTECTED_LINK');
    if(hash(readFileSync(p).toString().replace(/\r\n/g,'\n'))!==expected)throw new Error('KERNEL_INTEGRITY: '+file);
  }
  return {constitutionHash:digest(constitution),evaluatorHash:digest(manifest.files),version:manifest.version};
}
export function artifactManifest() {
  const files={};
  const visit=dir=>{for(const name of readdirSync(dir).sort()){const file=resolve(dir,name),stat=lstatSync(file);if(stat.isSymbolicLink())throw new Error('ARTIFACT_LINK');if(stat.isDirectory())visit(file);else files[relative(root,file).replaceAll('\\','/')]=hash(readFileSync(file));}};
  visit(resolve(root,'sdk/typescript/dist'));visit(resolve(root,'sdk/typescript/dist-cjs'));
  if(!Object.hasOwn(files,'sdk/typescript/dist/local.js'))throw new Error('MISSING_SDK_BUILD');return files;
}
export function verifyArtifacts(expected) {if(digest(artifactManifest())!==digest(expected))throw new Error('SDK_ARTIFACT_DRIFT');}
export const operators=['replay','conflict','unknown','absent','unavailable','missing-result','corrupt-receipt','concurrency','restart','attempt','omit-field'];
export function validateStrategy(value) {
  if(!value || Object.keys(value).sort().join(',')!=='casesPerOperator,operators,version' || !['M0','M1'].includes(value.version) ||
    !Array.isArray(value.operators) || value.operators.length<1 || value.operators.length>operators.length || new Set(value.operators).size!==value.operators.length ||
    value.operators.some(x=>!operators.includes(x)) || !Number.isInteger(value.casesPerOperator) || value.casesPerOperator<1 || value.casesPerOperator>3)throw new Error('INVALID_STRATEGY');
  return value;
}

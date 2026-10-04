// Human-controlled maintenance tool, never callable by candidate language.
import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { root, hash } from './common.mjs';
if(process.argv[2]!=='--human-update')throw new Error('EXPLICIT_HUMAN_KERNEL_UPDATE_REQUIRED');
const files={};
function visit(dir){for(const name of readdirSync(dir).sort()) {
  const file=resolve(dir,name),rel=relative(root,file).replaceAll('\\','/');
  if(lstatSync(file).isSymbolicLink())throw new Error('PROTECTED_LINK');
  if(lstatSync(file).isDirectory())visit(file);
  else if(!['evolution/constitution/protected-hashes.json','evolution/zone/strategy.json'].includes(rel))files[rel]=hash(readFileSync(file,'utf8').replace(/\r\n/g,'\n'));
}}
visit(resolve(root,'evolution'));
files['.github/workflows/evolution-ci.yml']=hash(readFileSync(resolve(root,'.github/workflows/evolution-ci.yml'),'utf8').replace(/\r\n/g,'\n'));
writeFileSync(resolve(root,'evolution/constitution/protected-hashes.json'),JSON.stringify({version:'trusted-kernel/1',files},null,2)+'\n');

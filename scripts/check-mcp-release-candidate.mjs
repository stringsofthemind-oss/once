import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const read = path => JSON.parse(readFileSync(new URL('../' + path, import.meta.url), 'utf8'));
const pkg = read('mcp/package.json'), registry = read('mcp/server.json');
const record = read('mcp/release-artifact.json'), published = read('docs/published-versions.json');
const version = process.env.EXPECTED_VERSION;
const semver = /^\d+\.\d+\.\d+$/;
function newer(a,b) {
  const aa=a.split('.').map(Number), bb=b.split('.').map(Number);
  for(let i=0;i<3;i++) if(aa[i]!==bb[i]) return aa[i]>bb[i];
  return false;
}
if (!semver.test(version ?? '') || !semver.test(published.mcp) || !newer(version,published.mcp) ||
    pkg.name !== '@once-agent/mcp' || pkg.version !== version || registry.version !== version ||
    registry.packages?.length !== 1 || registry.packages[0].identifier !== pkg.name ||
    registry.packages[0].version !== version || record.name !== pkg.name || record.version !== version ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(record.integrity) || !/^[0-9a-f]{64}$/.test(record.sha256) ||
    !Number.isSafeInteger(record.files) || record.files < 1) throw Error('Reviewed new-release metadata mismatch.');
const arg=process.argv[2];
async function lookup() {
  return fetch('https://registry.npmjs.org/@once-agent%2Fmcp/'+version,
    {redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Cache-Control':'no-cache'}});
}
if(arg==='--registry-before') {
  const res=await lookup();
  if(res.status!==404) throw Error('Version absence not established; do not publish again.');
} else if(arg==='--registry-after') {
  for(let i=0;i<12;i++) {
    const res=await lookup();
    if(res.status===200) {
      const data=await res.json();
      if(data.name!==record.name || data.version!==version || data.dist?.integrity!==record.integrity)
        throw Error('Published artifact mismatch; stop.');
      if(data.dist?.attestations?.url) { console.log('Exact npm integrity and provenance metadata confirmed.'); process.exit(0); }
    } else if(res.status!==404) throw Error('Registry verification unavailable.');
    await delay(5000);
  }
  throw Error('Provenance not yet verified; do not republish.');
} else if(arg) {
  const filename='once-agent-mcp-'+version+'.tgz';
  const [pack]=JSON.parse(readFileSync(join(arg,'pack.json'),'utf8'));
  const bytes=readFileSync(join(arg,filename));
  const digest='sha512-'+createHash('sha512').update(bytes).digest('base64');
  if(pack.name!==pkg.name || pack.version!==version || pack.filename!==filename ||
    pack.integrity!==digest || digest!==record.integrity || pack.files.length!==record.files ||
    createHash('sha256').update(bytes).digest('hex')!==record.sha256)
    throw Error('Pack differs from exact reviewed release artifact.');
  console.log('Exact reviewed artifact verified.');
}

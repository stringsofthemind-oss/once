import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL('../'+file, import.meta.url),'utf8');
const json = file => JSON.parse(read(file));
test('candidate metadata aligns without advancing published site or reviewed plugin authority',()=>{
  const pkg=json('mcp/package.json'), manifest=json('mcp/server.json'), lock=json('mcp/package-lock.json');
  assert.equal(manifest.version,pkg.version);
  assert.ok(manifest.description.length <= 100, 'Registry description limit');
  assert.equal(manifest.packages[0].version,pkg.version); assert.equal(lock.version,pkg.version);
  assert.equal(lock.packages[''].version,pkg.version); assert.equal(pkg.dependencies['@once-agent/sdk'],'0.1.25');
  const published=json('docs/published-versions.json');
  assert.equal(pkg.dependencies['@once-agent/sdk'],published.ts);
  for(const host of ['openai','claude-code'])assert.ok(read(`plugins/${host}/once/scripts/once-mcp.cjs`).includes(`@once-agent/mcp@${published.pluginMcp}`));
});
test('public compatibility distinguishes helper Node engines from local SQLite modes',()=>{
  assert.equal(json('mcp/package.json').engines.node,'>=20');
  const matrix=read('mcp/COMPATIBILITY.md').replace(/\s+/g,' ');
  assert.match(matrix,/Default MCP helper[^\n]*\| 20 \|/);
  assert.match(matrix,/Explicit MCP stdio proxy[^\n]*\| 24\.15 \|/);
  assert.match(matrix,/registered local-test order action[^\n]*\| 24\.15 \|/);
  assert.match(matrix,/Private experimental adapter\/host[^\n]*Excluded from public npm[^\n]*24\.15/);
  assert.ok(json('mcp/package.json').files.includes('COMPATIBILITY.md'));
  assert.doesNotMatch(read('mcp/README.md'),/Default helper\/proxy mode supports Node 20|controls are source-only/);
  assert.doesNotMatch(read('mcp/REGISTERED_ACTION.md'),/branch's package version still says|eventual release/);
});
test('continuity warning distinguishes preserved path from preserved authority',()=>{
  const matrix=read('mcp/COMPATIBILITY.md');
  for(const phrase of ['same filesystem path','Fresh installation','Continuation/restart','Backups','rolled-back copy','UNKNOWN','another valid database'])assert.ok(matrix.includes(phrase),phrase);
  for(const file of ['README.md','docs/index.html','docs/quickstart/index.html'])assert.match(read(file),/same filesystem path/);
  assert.match(matrix,/registered-action admission\s+guard/);
});
test('default MCP boundary and local versus Cloud contract are explicit in public docs',()=>{
  const readme=read('mcp/README.md');
  for(const phrase of ['eight developer','registered action is opt-in','reviewed/configured','cloudVerified','localValidated','ok:false','0.1.5'])assert.ok(readme.includes(phrase),phrase);
  for(const file of ['docs/claude-code-mcp-safe-retries/index.html','docs/cursor-mcp-safe-retries/index.html','docs/mcp-idempotency/index.html','docs/mcp-retry-safety/index.html'])assert.match(read(file),/does not automatically protect sibling/);
});

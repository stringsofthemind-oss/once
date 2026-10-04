import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('sdk/typescript/dist/first10-proof.js', root), 'utf8')
  .replace('import { wrapTool } from "./wrap-tool.js";', 'import { wrapTool } from "@once-agent/sdk";')
  .split('//# sourceMappingURL=')[0];
for (const file of ['examples/first10/prove.mjs', 'docs/first10/prove.mjs']) {
  const target = new URL(file, root);
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== source.replaceAll('\r\n', '\n')) {
      console.error(`Stale proof asset: ${file}`); process.exitCode = 1;
    }
  } else writeFileSync(target, source);
}

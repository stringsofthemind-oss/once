import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function coldMetrics(directory) {
  const html=readFileSync(resolve(directory,'docs/first10/index.html'),'utf8');
  const guide=readFileSync(resolve(directory,'examples/first10/README.md'),'utf8');
  const runtime=html.indexOf('Node.js 24.15+');
  const command=html.indexOf('npx --yes --package=@once-agent/sdk@0.1.25 once prove');
  const safety=['UNKNOWN is protection','Absence alone does not permit local redispatch','Exclude Authorization credentials','transport request ID is not the business operation'];
  return {evidenceKind:'SYNTHETIC_STRUCTURAL_NOT_HUMAN',prerequisiteOrderViolations:Number(runtime<0||command<0||runtime>command),
    reportInspectionInstructions:Number(guide.includes('node -e')&&guide.includes('report.json')&&guide.includes('process.argv[1]')),
    minimumProofCommands:1,safetyWordingPreserved:safety.every(x=>html.includes(x)),bytes:Buffer.byteLength(html)+Buffer.byteLength(guide)};
}
export function documentationGates(baseline,candidate) {
  return candidate.safetyWordingPreserved && candidate.minimumProofCommands===baseline.minimumProofCommands &&
    candidate.prerequisiteOrderViolations<=baseline.prerequisiteOrderViolations && candidate.reportInspectionInstructions>=baseline.reportInspectionInstructions;
}
export const evidenceGuide = `\n## Inspect the measured evidence\n\nReplace the final argument below with the evidence directory printed by the proof. Keep the quotes for paths containing spaces. This reads the report without changing SQLite or provider state:\n\n\`\`\`sh\nnode -e "const fs=require('node:fs'),p=require('node:path');console.log(fs.readFileSync(p.join(process.argv[1],'report.json'),'utf8'))" "PRINTED_EVIDENCE_DIRECTORY"\n\`\`\`\n\nThe report's without-once writes are 2; confirmed and lost-ack writes are 1. Lost-ack initialStatus is UNKNOWN, finalStatus is CONFIRMED only after authoritative reconciliation, and unsafeRedispatches is 0. Missing evidence or a read error is not success or permission to retry. This fixture does not certify your own operation.\n`;
export function applyDocumentation(operation,html,guide) {
  if(['move-prerequisite','combined-docs'].includes(operation)) {
    const prerequisite='<p>Node.js 24.15+. An independent local HTTP provider keeps a separate effect journal. No cloud account, keys or payment account.</p>';
    if(html.split(prerequisite).length!==2)throw new Error('STALE_DOCUMENT');
    html=html.replace(prerequisite,'').replace('<p>One command runs the same controlled fixture:</p>',prerequisite+'<p>One command runs the same controlled fixture:</p>');
  }
  if(['add-evidence-guide','combined-docs'].includes(operation))guide+=evidenceGuide;
  return {html,guide};
}

// Trusted interpreter. Candidate data is never eval'd, imported or passed to a shell.
import { readFileSync, writeFileSync } from 'node:fs';
const [input,output]=process.argv.slice(2);
const data=JSON.parse(readFileSync(input,'utf8'));
if(Object.keys(data).sort().join(',')!=='generation,knowledge,strategy')throw new Error('INVALID_INPUT');
const vocabulary=['replay','conflict','unknown','absent','unavailable','missing-result','corrupt-receipt','concurrency','restart','attempt','omit-field'];
const strategy=data.strategy;
if(!strategy || Object.keys(strategy).sort().join(',')!=='casesPerOperator,operators,version' || !['M0','M1'].includes(strategy.version) ||
  !Array.isArray(strategy.operators)||strategy.operators.some(x=>!vocabulary.includes(x))||strategy.operators.length>11 ||
  !Number.isInteger(strategy.casesPerOperator)||strategy.casesPerOperator<1||strategy.casesPerOperator>3)throw new Error('INVALID_STRATEGY');
const proposals=data.generation===0 ? [
  {id:'prerequisite-first',ring:3,operation:'move-prerequisite',hypothesis:'Prerequisite order violation becomes zero without adding proof commands.'},
  {id:'evidence-handoff',ring:3,operation:'add-evidence-guide',hypothesis:'Concrete report inspection removes one undocumented evidence handoff.'},
  {id:'tamper-evaluator',ring:0,operation:'tamper',hypothesis:'Controlled malicious candidate tries to rewrite its judge.'},
  {id:'strategy-M1',ring:4,operation:'improve-strategy',hypothesis:'More distinct fault dimensions expose dangerous mutants missed by replay-only M0.'}
] : [
  {id:'prerequisite-evidence',ring:3,operation:'combined-docs',hypothesis:'Use the previous generation lesson to address ordering and report handoff together.'},
  {id:'evidence-handoff-g1',ring:3,operation:'add-evidence-guide',hypothesis:'Retain the evidence-only alternative rather than collapse lineage.'}
];
// Bounded executable behavior controlled by strategy data: actual fault schedules.
const cases=strategy.operators.flatMap((scenario,index)=>Array.from({length:strategy.casesPerOperator},(_,i)=>({id:`generated-${index}-${i}`,amount:5000+i,currency:i?'USD':'GBP',scenario})));
writeFileSync(output,JSON.stringify({strategyVersion:strategy.version,knowledgeUsed:data.knowledge.map(x=>x.rule),proposals,cases})+'\n',{flag:'wx'});

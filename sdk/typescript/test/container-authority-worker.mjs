import pg from 'pg';
import { createPostgresExecutionAuthority, createPostgresContinuityWitness, protectToolCall } from '../dist/index.js';
const mode = process.argv[2], id = process.argv[3];
const pool = new pg.Pool({ connectionString: 'postgresql://once:fixture@execution/postgres', connectionTimeoutMillis: 800 });
const witnessPool = new pg.Pool({ connectionString: 'postgresql://once:fixture@continuity/postgres', connectionTimeoutMillis: 800 });
const authority = createPostgresExecutionAuthority({ pool, witness: createPostgresContinuityWitness({ pool: witnessPool, expectedWitnessId: 'container-witness' }), authorityId: 'container-authority', expectedGeneration: 'g1', expectedEpoch: '1', witnessTimeoutMs: 1200 });
try {
  const result = await protectToolCall({ operationId: id, effect: { tool: 'fixture.account.refund', args: { id, amount: mode === 'conflict' ? 2 : 1 } }, authority,
    execute: async ({ args }) => {
      const response = await fetch('http://provider:8080/effect', { method: 'POST', body: JSON.stringify(args) });
      const receipt = await response.json();
      if (mode === 'crash') process.exit(73);
      return receipt;
    },
    reconcile: mode === 'reconcile' ? async () => {
      const journal = await (await fetch('http://provider:8080/journal')).json();
      const matches = journal.filter(x => x.id === id && x.amount === 1);
      return matches.length === 1 ? { status: 'CONFIRMED', result: matches[0] } : { status: 'UNKNOWN' };
    } : undefined,
  });
  console.log(JSON.stringify({ status: 'CONFIRMED', result }));
} catch (error) { console.log(JSON.stringify({ status: error.code ?? 'UNEXPECTED' })); }
finally { await pool.end(); await witnessPool.end(); }

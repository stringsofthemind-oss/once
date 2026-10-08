// Separate application process. Provider and witness live outside this process.
import pg from 'pg';
import { writeSync } from 'node:fs';
import { createPostgresExecutionAuthority, protectToolCall } from '../dist/index.js';

const config = JSON.parse(process.env.ONCE_TEST_WORKER);
const pool = new pg.Pool({ connectionString: process.env.ONCE_TEST_DATABASE, max: 2 });
const witness = { async compareAndAdvance(expected, next) {
  const response = await fetch(`${config.fixture}/cas`, { method: 'POST', body: JSON.stringify({ expected, next }) });
  if (!response.ok) throw new Error('witness unavailable');
  return (await response.json()).accepted;
} };
const shared = createPostgresExecutionAuthority({ pool, witness, authorityId: config.authorityId, expectedGeneration: 'generation-1', expectedEpoch: '1' });
const authority = config.crashBefore ? { async open() {
  const store = await shared.open();
  return { ...store, async reserve(...args) {
    await store.reserve(...args);
    writeSync(1, 'CRASH_BEFORE_PROVIDER_DISPATCH'); process.kill(process.pid, 'SIGKILL');
  } };
} } : shared;
try {
  const result = await protectToolCall({
    operationId: config.id, effect: { tool: 'fixture.account-A.refund', args: { id: config.id, amount: config.amount ?? 100 } },
    authority, leaseMs: config.leaseMs ?? 30000,
    execute: async ({ args }) => {
      const response = await fetch(`${config.fixture}/effect`, { method: 'POST', body: JSON.stringify(args) });
      const receipt = await response.json();
      if (config.crash) { writeSync(1, 'CRASH_AFTER_PROVIDER_COMMIT'); process.kill(process.pid, 'SIGKILL'); }
      return receipt;
    },
  });
  console.log(JSON.stringify({ result }));
} catch (error) { console.log(JSON.stringify({ code: error.code })); }
finally { await pool.end(); }

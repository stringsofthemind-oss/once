// Disposable host, not a default plugin mode or a deployable provider adapter.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { registerProtectedOrderAction } from '@once-agent/mcp/registered-action';
import { writeFileSync } from 'node:fs';

const config = JSON.parse(process.env.ONCE_TEST_HOST);
const authority = { provider: 'disposable-orders', accountId: config.accountId, environment: 'local-test' };
const request = async (pathname, body) => {
  const response = await fetch(`${config.providerUrl}${pathname}`, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    headers: { Authorization: `Bearer ${config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw Error('provider request failed');
  return response.json();
};
const server = new McpServer({ name: 'once-registered-order-fixture', version: '1' });
const pools = [];
const metrics = { execution: { statements: 0, transactions: 0 }, witness: { statements: 0, transactions: 0 }, memory: {} };
let intentAuthority;
if (config.shared) {
  const { default: pg } = await import('pg');
  const { createPostgresContinuityWitness, createPostgresIntentAuthority } = await import('@once-agent/sdk');
  const pool = new pg.Pool({ connectionString: config.shared.executionUrl, connectionTimeoutMillis: 1000 });
  const witnessPool = new pg.Pool({ connectionString: config.shared.witnessUrl, connectionTimeoutMillis: 1000 });
  for (const [kind, p] of [['execution', pool], ['witness', witnessPool]]) {
    p.on('error', () => {}); pools.push(p);
    const connect = p.connect.bind(p);
    p.connect = async () => {
      const client = await connect(), query = client.query.bind(client);
      return { query: async (...args) => {
        metrics[kind].statements++;
        if (String(args[0]).startsWith('BEGIN')) metrics[kind].transactions++;
        const result = await query(...args); metrics.memory = process.memoryUsage(); return result;
      }, release: client.release.bind(client) };
    };
  }
  const witness = createPostgresContinuityWitness({ pool: witnessPool, expectedWitnessId: config.shared.witnessId, expectedSchemaVersion: 2 });
  const execution = createPostgresIntentAuthority({ pool, witness, authorityId: config.shared.authorityId,
    expectedGeneration: config.shared.generation, expectedEpoch: config.shared.epoch, witnessTimeoutMs: 1000 });
  intentAuthority = { authority: execution, scope: config.shared.scope, resolveKey: async () => config.trustedIntentKey };
}
const registration = await registerProtectedOrderAction(server, {
  name: config.name,
  authority,
  resourceId: config.resourceId,
  ...(intentAuthority ? { intentAuthority } : { statePath: config.statePath }),
  leaseMs: config.leaseMs,
  // The parent test owns this private stdio process and its credentials. This
  // grants that parent access; network deployments need real host admission.
  authorize: async () => { if (config.denyAdmission) throw Error('not admitted'); },
  provider: {
    assertAuthority: () => request('/authority'),
    create: async (effect, operationId) => {
      if (config.lookupOnly) throw Error('read-only recovery host never executes provider creates');
      if (config.beforeProviderMarker) {
        writeFileSync(config.beforeProviderMarker, JSON.stringify({ pid: process.pid, operationId }), { flush: true });
        await new Promise(() => {});
      }
      try { return await request('/orders', { effect, operationId }); }
      catch (error) {
        // Test-only crash barrier: the socket has failed, but Once has not yet
        // received the exception. The parent kills this process at this marker.
        if (config.afterAckLossMarker) {
          writeFileSync(config.afterAckLossMarker, JSON.stringify({ pid: process.pid, operationId }), { flush: true });
          await new Promise(() => {});
        }
        throw error;
      }
    },
    lookup: operationId => request(`/orders/${encodeURIComponent(operationId)}`),
  },
});
process.on('exit', () => registration.close());
process.on('exit', () => { if (config.metricsPath) writeFileSync(config.metricsPath, JSON.stringify(metrics, null, 2)); });
process.stdin.on('end', () => { registration.close(); Promise.all(pools.map(p => p.end())).catch(() => {}); });
serveStdio(() => server);

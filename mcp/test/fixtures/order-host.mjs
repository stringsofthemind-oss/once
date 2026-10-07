// Disposable host, not a default plugin mode or a deployable provider adapter.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { registerProtectedOrderAction } from '@once-agent/mcp/registered-action';

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
const registration = await registerProtectedOrderAction(server, {
  name: config.name,
  authority,
  resourceId: config.resourceId,
  statePath: config.statePath,
  // The parent test owns this private stdio process and its credentials. This
  // grants that parent access; network deployments need real host admission.
  authorize: async () => { if (config.denyAdmission) throw Error('not admitted'); },
  provider: {
    assertAuthority: () => request('/authority'),
    create: (effect, operationId) => request('/orders', { effect, operationId }),
    lookup: operationId => request(`/orders/${encodeURIComponent(operationId)}`),
  },
});
process.on('exit', () => registration.close());
serveStdio(() => server);

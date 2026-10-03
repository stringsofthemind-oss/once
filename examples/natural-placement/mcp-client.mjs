import { wrapTool } from '@once-agent/sdk';

// Bind an already connected fixed-authority client. Audit internal retries.
// lookupExact must return tool-call truth for the exact declared effect.
export function protectMcpAppend(client, { statePath, serverId, accountId, lookupExact }) {
  return wrapTool(args => client.callTool({ name: 'append', arguments: args }), {
    statePath,
    operationId: ({ intent }) => intent,
    effect: ({ intent, body }) => ({
      tool: JSON.stringify(['mcp', serverId, accountId, 'append']),
      args: { intent, body },
    }),
    reconcile: ({ effect }) => lookupExact(client, effect),
  });
}

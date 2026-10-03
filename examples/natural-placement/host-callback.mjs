import { wrapTool } from '@once-agent/sdk';

// host.send and host.lookupExact must use the fixed declared account.
export function protectSend(host, { statePath, accountId }) {
  return wrapTool(host.send.bind(host), {
    statePath,
    operationId: ({ intent }) => intent,
    effect: ({ intent, message }) => ({
      tool: `messaging.${accountId}.send`,
      args: { intent, message },
    }),
    reconcile: ({ effect }) => host.lookupExact(effect.args),
  });
}

import { protectToolCall } from '@once-agent/sdk';

// Every child starts with empty process memory and opens the same durable ledger.
const options = JSON.parse(process.argv[2]);
try {
  const result = await protectToolCall({
    operationId: options.operationId, effect: options.effect,
    statePath: options.statePath, leaseMs: options.leaseMs ?? 30000,
    execute: async ({ args }) => {
      const response = await fetch(`${args.provider}/effects`, {
        method: 'POST', body: JSON.stringify(args),
      });
      const receipt = await response.json();
      if (options.crash) process.exit(77); // effect committed, Once confirmation absent
      return receipt;
    },
    reconcile: options.truth ? async ({ effect }) => {
      if (options.truth === 'unavailable') throw Error('provider lookup unavailable');
      if (options.truth === 'missing') return { status: 'NOT_FOUND' };
      if (options.truth === 'malformed') return { status: 'CONFIRMED' };
      const rows = await (await fetch(`${effect.args.provider}/effects`)).json();
      const matches = rows.filter(row => JSON.stringify(row.args) === JSON.stringify(effect.args));
      return matches.length === 1
        ? { status: 'CONFIRMED', result: matches[0].receipt }
        : { status: 'UNKNOWN' };
    } : undefined,
  });
  console.log(JSON.stringify({ result }));
} catch (error) {
  console.log(JSON.stringify({ code: error.code, message: error.message }));
  process.exitCode = 2;
}

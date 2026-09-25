import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, Runner, tool } from '@openai/agents';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '@openai/agents/testing';
import { z } from 'zod';
import {
  connectLocalAgentTool,
  LocalProtectionError,
} from '@once-agent/sdk';

const directory = mkdtempSync(
  path.join(os.tmpdir(), 'once-openai-lost-ack-'),
);

const statePath = path.join(directory, 'once.sqlite');

const effects = [];
const providerTruth = new Map();

let providerExecutions = 0;
let reconcileCalls = 0;

const provider = {
  async execute({ intent, seat }) {
    providerExecutions += 1;

    const receipt = {
      confirmation: `booking-${providerExecutions}`,
      intent,
      seat,
    };

    // The external mutation commits successfully.
    effects.push({ intent, seat });
    providerTruth.set(intent, receipt);

    // Simulate the dangerous distributed-systems case:
    // provider committed, but the acknowledgement was lost.
    throw new Error('simulated lost ACK after provider commit');
  },
};

const booking = connectLocalAgentTool(provider, {
  name: 'book_seat',

  safety: {
    changesExternalState: true,
    retryPossible: true,
    ambiguousOutcomePossible: true,
    duplicateUndesirable: true,
  },

  // Stable logical identity survives framework retries.
  id: ({ intent }) => intent,

  payload: ({ seat }) => ({ seat }),

  statePath,

  // Read-only authoritative provider truth.
  reconcile: async ({ id }) => {
    reconcileCalls += 1;

    const providerIntent = id.startsWith('book_seat:')
      ? id.slice('book_seat:'.length)
      : id;

    const receipt = providerTruth.get(providerIntent);

    if (!receipt) {
      return { state: 'ABSENT' };
    }

    return {
      state: 'CONFIRMED',
      result: receipt,
    };
  },
});

async function runAgentAttempt({
  intent,
  seat,
  callId,
}) {
  const observed = [];

  const bookSeat = tool({
    name: 'book_seat',
    description: 'Book one seat for the current customer request.',
    parameters: z.object({
      seat: z.string(),
    }),

    async execute({ seat }) {
      try {
        const result = await booking.execute({
          intent,
          seat,
        });

        observed.push({
          kind: 'result',
          value: result,
        });

        return JSON.stringify(result);
      } catch (error) {
        if (error instanceof LocalProtectionError) {
          observed.push({
            kind: 'blocked',
            code: error.code,
          });

          return JSON.stringify({
            blocked: error.code,
          });
        }

        throw error;
      }
    },
  });

  const model = new ScriptedModel([
    [
      functionCall(
        'book_seat',
        { seat },
        { callId },
      ),
    ],
    [
      assistantMessage('Tool response received.'),
    ],
  ]);

  const agent = new Agent({
    name: 'Lost ACK booking agent',
    model,
    tools: [bookSeat],
  });

  const response = await new Runner({
    tracingDisabled: true,
  }).run(
    agent,
    'Book my seat.',
  );

  assert.equal(
    response.finalOutput,
    'Tool response received.',
  );

  assert.equal(model.calls.length, 2);

  assert(
    model.lastCall.request.input.some(
      item => item.type === 'function_call_result',
    ),
  );

  model.assertComplete();

  return observed[0];
}

try {
  console.log('');
  console.log('=== ONCE + OPENAI AGENTS LOST-ACK ADVERSARIAL PROOF ===');
  console.log('');

  const first = await runAgentAttempt({
    intent: 'customer-A',
    seat: '42',
    callId: 'call_1',
  });

  console.log('Attempt #1');
  console.log('framework call id: call_1');
  console.log('logical operation: customer-A');
  console.log('agent observed:', first);
  console.log('provider executions:', providerExecutions);
  console.log('external effects:', effects.length);
  console.log('');

  assert.deepEqual(first, {
    kind: 'blocked',
    code: 'UNKNOWN',
  });

  assert.equal(providerExecutions, 1);
  assert.equal(effects.length, 1);
  assert.equal(reconcileCalls, 0);

  const retry = await runAgentAttempt({
    intent: 'customer-A',
    seat: '42',
    callId: 'call_2',
  });

  console.log('Attempt #2');
  console.log('framework call id: call_2');
  console.log('logical operation: customer-A');
  console.log('agent observed:', retry);
  console.log('provider executions:', providerExecutions);
  console.log('external effects:', effects.length);
  console.log('reconcile calls:', reconcileCalls);
  console.log('');

  assert.deepEqual(retry, {
    kind: 'result',
    value: {
      confirmation: 'booking-1',
      intent: 'customer-A',
      seat: '42',
    },
  });

  // THE CRITICAL INVARIANTS.
  assert.equal(providerExecutions, 1);
  assert.equal(effects.length, 1);
  assert.equal(reconcileCalls, 1);

  console.log('PASS  two distinct OpenAI Agents tool-call IDs');
  console.log('PASS  one stable logical operation');
  console.log('PASS  first provider mutation committed');
  console.log('PASS  first acknowledgement was lost');
  console.log('PASS  Once surfaced UNKNOWN');
  console.log('PASS  retry did NOT redispatch provider mutation');
  console.log('PASS  retry reconciled authoritative provider truth');
  console.log('PASS  original receipt recovered');
  console.log('PASS  provider executions = 1');
  console.log('PASS  external effects = 1');
  console.log('PASS  duplicate effects = 0');

  console.log('');
  console.log('LOST-ACK ADVERSARIAL PROOF: PASS');
  console.log('');
} finally {
  rmSync(directory, {
    recursive: true,
    force: true,
  });
}

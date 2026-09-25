import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, Runner, tool } from '@openai/agents';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { z } from 'zod';
import { connectLocalAgentTool, LocalProtectionError } from '@once-agent/sdk';

const directory = mkdtempSync(path.join(os.tmpdir(), 'once-agents-published-'));
const effects = [];
const provider = {
  async execute({ intent, seat }) {
    effects.push({ intent, seat });
    return { confirmation: `booking-${effects.length}` };
  },
};

try {
  const booking = connectLocalAgentTool(provider, {
    name: 'book_seat',
    safety: {
      changesExternalState: true,
      retryPossible: true,
      ambiguousOutcomePossible: true,
      duplicateUndesirable: true,
    },
    id: ({ intent }) => intent,
    payload: ({ seat }) => ({ seat }),
    statePath: path.join(directory, 'once.sqlite'),
  });

  // An application assigns an intent to a user request and persists that ID
  // for retries. The model supplies only the booking details, not identity.
  async function runRequest(intent, seat, callId) {
    const results = [];
    const bookSeat = tool({
      name: 'book_seat',
      description: 'Book one seat for the current customer request.',
      parameters: z.object({ seat: z.string() }),
      async execute({ seat }) {
        try {
          const result = await booking.execute({ intent, seat });
          results.push(result);
          return JSON.stringify(result);
        } catch (error) {
          if (error instanceof LocalProtectionError) {
            results.push({ blocked: error.code });
            return JSON.stringify({ blocked: error.code });
          }
          throw error;
        }
      },
    });
    const model = new ScriptedModel([
      [functionCall('book_seat', { seat }, { callId })],
      [assistantMessage('Tool response received.')],
    ]);
    const agent = new Agent({ name: 'Booking agent', model, tools: [bookSeat] });
    const response = await new Runner({ tracingDisabled: true }).run(agent, 'Book my seat.');
    assert.equal(response.finalOutput, 'Tool response received.');
    assert.equal(model.calls.length, 2);
    assert(model.lastCall.request.input.some(item => item.type === 'function_call_result'));
    model.assertComplete();
    return results[0];
  }

  const first = await runRequest('customer-A', '42', 'call_1');
  const retry = await runRequest('customer-A', '42', 'call_2');
  const second = await runRequest('customer-B', '42', 'call_3');
  const changed = await runRequest('customer-A', '43', 'call_4');

  assert.deepEqual(first, { confirmation: 'booking-1' });
  assert.deepEqual(retry, first);
  assert.deepEqual(second, { confirmation: 'booking-2' });
  assert.deepEqual(changed, { blocked: 'CONFLICT' });
  assert.equal(effects.length, 2);
  console.log('OpenAI Agents SDK + published Once 0.1.11: 4 agent runs, 2 effects, retry replayed, changed payload blocked');
} finally {
  rmSync(directory, { recursive: true, force: true });
}

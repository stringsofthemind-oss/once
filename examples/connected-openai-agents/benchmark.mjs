import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectLocalAgentTool } from '@once-agent/sdk';

const directory = mkdtempSync(path.join(os.tmpdir(), 'once-agent-latency-'));
let effects = 0;

try {
  const booking = connectLocalAgentTool({
    async execute() {
      effects += 1;
      return { confirmation: effects };
    },
  }, {
    name: 'book_seat',
    safety: {
      changesExternalState: true,
      retryPossible: true,
      ambiguousOutcomePossible: true,
      duplicateUndesirable: true,
    },
    id: ({ intent }) => intent,
    payload: ({ seat }) => ({ seat }),
    statePath: path.join(directory, 'operations.sqlite'),
  });

  function percentile(sorted, fraction) {
    return sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2);
  }

  async function sample(mode) {
    const durations = [];
    // First invocation warms the import and state creation path.
    for (let i = 0; i <= 100; i += 1) {
      const input = { intent: mode === 'claim' ? `booking-${i}` : 'booking-0', seat: '42' };
      const started = performance.now();
      await booking.execute(input);
      if (i > 0) durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    return { medianMs: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95) };
  }

  console.log(JSON.stringify({
    node: process.version,
    sampleCountPerMode: 100,
    claim: await sample('claim'),
    confirmedReplay: await sample('replay'),
    providerEffects: effects,
  }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

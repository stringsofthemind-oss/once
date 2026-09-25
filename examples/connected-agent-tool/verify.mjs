import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  connectLocalAgentTool,
  LocalProtectionError,
} from "../../sdk/typescript/dist/index.js";

const directory = mkdtempSync(path.join(os.tmpdir(), "once-connected-agent-"));
const effects = [];
const provider = {
  async execute(input) {
    effects.push({ seat: input.seat, intent: input.intent });
    return { booking: `booking-${effects.length}` };
  },
};

try {
  // The app exposes the connected tool to its agent. The agent calls execute
  // normally, without an extra model-generated "use Once" step.
  const bookingTool = connectLocalAgentTool(provider, {
    name: "book_seat",
    safety: {
      changesExternalState: true,
      retryPossible: true,
      ambiguousOutcomePossible: true,
      duplicateUndesirable: true,
    },
    id: input => input.intent, // One intentional booking, stable on retry.
    payload: input => ({ seat: input.seat }), // Every effect-changing input.
    statePath: path.join(directory, "operations.sqlite"),
  });

  const first = await bookingTool.execute({ intent: "booking-A", seat: "42" });
  const retry = await bookingTool.execute({ intent: "booking-A", seat: "42" });
  const second = await bookingTool.execute({ intent: "booking-B", seat: "42" });
  assert.deepEqual(first, retry);
  assert.notDeepEqual(first, second);
  assert.equal(effects.length, 2);
  await assert.rejects(
    bookingTool.execute({ intent: "booking-A", seat: "43" }),
    error => error instanceof LocalProtectionError && error.code === "CONFLICT",
  );
  console.log("Connected agent tool: 3 calls / 2 intentional bookings / 2 provider effects / payload conflict blocked");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

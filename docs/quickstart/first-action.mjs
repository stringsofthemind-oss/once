import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { protectLocal } from "@once-agent/sdk";

// Controlled fake provider: its effect journal is separate from Once state.
// This verifies the installed SDK, not a real payment or ticket integration.
const directory = path.resolve(".once-first-action");
mkdirSync(directory, { recursive: true });
const statePath = path.join(directory, "operations.sqlite");
const mode = process.argv[2] || "verify";
assert.ok(["verify", "restart", "unknown", "reconcile"].includes(mode));
const journal = name => path.join(directory, `${name}.jsonl`);
const rows = name => existsSync(journal(name))
  ? readFileSync(journal(name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  : [];

// In your integration use a durable intentional action ID, scoped by tenant
// and action type, and bind EVERY input that can change the external effect.
const identity = input => `demo-tenant:create-ticket:${input.intentId}`;
const payload = input => ({ intentId: input.intentId, title: input.title });
const createTicket = protectLocal(async input => {
  const result = { number: "TICKET-1", title: input.title };
  appendFileSync(journal("confirmed"), JSON.stringify(result) + "\n");
  return result;
}, { id: identity, payload, statePath });

const original = { intentId: "ticket-001", title: "Investigate timeout" };
if (mode === "verify") {
  const result = await createTicket(original);
  assert.deepEqual(await createTicket(original), result);
  await assert.rejects(createTicket({ ...original, title: "Changed title" }), { code: "CONFLICT" });
  assert.equal(rows("confirmed").length, 1);
  console.log("CONFIRMED: TICKET-1\nREPLAY: original result\nCONFLICT: no write dispatched\nProvider effects: 1");
} else if (mode === "restart") {
  assert.equal(rows("confirmed").length, 1, "Run verify first; keep the state directory.");
  assert.deepEqual(await createTicket(original), rows("confirmed")[0]);
  assert.equal(rows("confirmed").length, 1);
  console.log("RESTART REPLAY: TICKET-1\nProvider effects: 1");
} else {
  // The fake provider commits, THEN its acknowledgement is lost.
  const lostInput = { intentId: "ticket-lost-ack", title: "Lost acknowledgement" };
  const lost = protectLocal(async input => {
    const result = { number: "TICKET-LOST", title: input.title };
    appendFileSync(journal("ambiguous"), JSON.stringify(result) + "\n");
    throw new Error("Simulated acknowledgement loss after commit");
  }, {
    id: identity, payload, statePath,
    ...(mode === "reconcile" ? {
      // Authoritative ONLY for this controlled fake provider. A real provider
      // needs its own trustworthy, read-only lookup and concurrency contract.
      reconcile: () => rows("ambiguous").length === 1
        ? { state: "CONFIRMED", result: rows("ambiguous")[0] }
        : { state: "UNKNOWN" },
    } : {}),
  });
  if (mode === "unknown") {
    await assert.rejects(lost(lostInput));
    await assert.rejects(lost(lostInput), { code: "UNKNOWN" });
    assert.equal(rows("ambiguous").length, 1);
    console.log("UNKNOWN: retry blocked\nAmbiguous provider effects: 1");
  } else {
    assert.equal(rows("ambiguous").length, 1, "Run unknown first.");
    assert.equal((await lost(lostInput)).number, "TICKET-LOST");
    assert.equal(rows("ambiguous").length, 1);
    console.log("RECONCILED: TICKET-LOST\nAmbiguous provider effects: 1");
  }
}

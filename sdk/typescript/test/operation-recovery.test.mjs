import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  approveLocalToolIntent,
  createPostgresAdmissionWitness,
  executeApprovedLocalTool,
  listUnresolvedLocalOperations,
  protectToolCall,
  provisionLocalLedger,
  readLocalOperationStatus,
  reconcileApprovedLocalTool,
  reconcileToolCall,
} from "../dist/index.js";

const effect = { tool: "fixture:booking:amend", args: { expectedVersion: 1, customer: "private-data" } };
const intent = { tenant: "tenant-A", providerAccount: "provider-A", intentId: "approval-1" };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "once-operation-recovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, statePath: join(dir, "operations #1.sqlite") };
}

test("status and strict recovery never provision a missing legacy ledger", async t => {
  const { statePath } = fixture(t);
  const options = { statePath, operationId: "fixture", effect };
  let dispatches = 0;
  await assert.rejects(readLocalOperationStatus(options.operationId, statePath), { code: "STATE_UNAVAILABLE" });
  await assert.rejects(reconcileToolCall(options), { code: "STATE_UNAVAILABLE" });
  await assert.rejects(protectToolCall({
    ...options, ledgerMode: "existing", execute: async () => ++dispatches,
  }), { code: "STATE_UNAVAILABLE" });
  assert.equal(existsSync(statePath), false);
  assert.equal(dispatches, 0);

  await protectToolCall({ ...options, execute: async () => ++dispatches });
  assert.equal((await readLocalOperationStatus(options.operationId, statePath)).evidence, "stored_receipt");
  await assert.rejects(provisionLocalLedger(statePath), { code: "STATE_UNAVAILABLE" });
  const missing = { ...options, operationId: "unrecorded" };
  await assert.rejects(reconcileToolCall(missing), { code: "OPERATION_NOT_RECORDED" });
  assert.equal((await readLocalOperationStatus(missing.operationId, statePath)).state, "NOT_RECORDED");
});

test("host approval is bound to the tenant, provider account and immutable effect", async t => {
  const { statePath } = fixture(t);
  await provisionLocalLedger(statePath);
  let dispatches = 0;
  const request = { statePath, intent, effect };
  const execute = async (_effect, context) => {
    assert.ok(Object.isFrozen(context.intent));
    assert.equal(context.intent.providerAccount, "provider-A");
    return ++dispatches;
  };
  await assert.rejects(executeApprovedLocalTool({ ...request, execute }), { code: "INTENT_REQUIRED" });
  const operationId = await approveLocalToolIntent({ ...request, label: "Amend booking", assignedTo: "booking-ops" });
  assert.equal(await approveLocalToolIntent(request), operationId);
  const approval = await readLocalOperationStatus(operationId, statePath);
  assert.equal(approval.state, "APPROVED");
  assert.equal(approval.label, "Amend booking");
  assert.equal(approval.assignedTo, "booking-ops");
  assert.equal(approval.claimedAt, null);
  await assert.rejects(protectToolCall({ statePath, operationId, effect, execute }), { code: "INTENT_REQUIRED" });
  await assert.rejects(reconcileApprovedLocalTool(request), { code: "OPERATION_NOT_RECORDED" });
  for (const changed of [
    { effect: { ...effect, args: { ...effect.args, expectedVersion: 2 } }, code: "CONFLICT" },
    { intent: { ...intent, tenant: "tenant-B" }, code: "INTENT_REQUIRED" },
    { intent: { ...intent, providerAccount: "provider-B" }, code: "INTENT_REQUIRED" },
    { intent: { ...intent, intentId: "new-id" }, code: "INTENT_REQUIRED" },
  ]) {
    const { code, ...override } = changed;
    await assert.rejects(executeApprovedLocalTool({ ...request, ...override, execute }), { code });
  }
  await assert.rejects(approveLocalToolIntent({
    ...request, effect: { ...effect, args: {} },
  }), { code: "CONFLICT" });
  assert.equal(await executeApprovedLocalTool({ ...request, execute }), 1);
  assert.equal(await executeApprovedLocalTool({ ...request, execute }), 1);
  const separate = { ...request, intent: { ...intent, intentId: "approval-2" } };
  assert.notEqual(await approveLocalToolIntent(separate), operationId);
  assert.equal(await executeApprovedLocalTool({ ...separate, execute }), 2);
  assert.equal((await readLocalOperationStatus(operationId, statePath)).evidence, "execution_receipt");
});

test("the exception queue exposes evidence without payloads or receipts and can reconcile without dispatch", async t => {
  const { statePath } = fixture(t);
  await provisionLocalLedger(statePath);
  const request = { statePath, intent, effect };
  const operationId = await approveLocalToolIntent(request);
  let effects = 0;
  await assert.rejects(executeApprovedLocalTool({
    ...request, execute: async () => { effects++; throw new Error("lost acknowledgement"); },
  }), { code: "UNKNOWN" });
  const cli = fileURLToPath(new URL("../dist/once-cli.js", import.meta.url));
  const status = JSON.parse(execFileSync(process.execPath, [cli, "status", operationId, `--state=${statePath}`, "--json"]));
  assert.equal(status.state, "UNKNOWN");
  assert.ok(status.claimedAt >= status.approvedAt);
  assert.equal(JSON.stringify(status).includes("private-data"), false);
  const queue = JSON.parse(execFileSync(process.execPath, [cli, "status", "--unresolved", `--state=${statePath}`, "--json"]));
  assert.deepEqual(queue, [status]);
  assert.deepEqual(await listUnresolvedLocalOperations({ statePath, afterId: operationId }), []);
  await assert.rejects(reconcileApprovedLocalTool({
    ...request, reconcile: async () => ({ status: "NOT_FOUND" }),
  }), { code: "UNKNOWN" });
  const afterNegative = await readLocalOperationStatus(operationId, statePath);
  assert.equal(afterNegative.lastLookup, "NOT_FOUND");
  assert.ok(afterNegative.lastLookupAt >= status.claimedAt);
  const receipt = { providerReference: "private-reference" };
  assert.deepEqual(await reconcileApprovedLocalTool({
    ...request, reconcile: async () => ({ status: "CONFIRMED", result: receipt }),
  }), receipt);
  const final = await readLocalOperationStatus(operationId, statePath);
  assert.equal(final.state, "CONFIRMED");
  assert.equal(final.evidence, "provider_reconciliation");
  assert.equal(final.lastLookup, "CONFIRMED");
  assert.equal(JSON.stringify(final).includes("private-reference"), false);
  assert.deepEqual(await listUnresolvedLocalOperations({ statePath }), []);
  assert.equal(effects, 1);
});

test("a shared independent witness blocks fresh effects after local restore and across ledgers", async t => {
  const { dir, statePath } = fixture(t);
  const other = join(dir, "other.sqlite");
  const backup = join(dir, "before-dispatch.sqlite");
  const journal = new DatabaseSync(join(dir, "witness.sqlite"));
  t.after(() => journal.close());
  journal.exec("CREATE TABLE claims (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)");
  const witness = {
    id: "fixture-witness",
    reserve: async (id, fingerprint) =>
      journal.prepare("INSERT INTO claims VALUES (?,?) ON CONFLICT DO NOTHING").run(id, fingerprint).changes === 1,
  };
  await provisionLocalLedger(statePath, { witnessId: witness.id });
  await provisionLocalLedger(other, { witnessId: witness.id });
  const request = { statePath, intent, effect };
  const operationId = await approveLocalToolIntent(request);
  await approveLocalToolIntent({ ...request, statePath: other });
  const original = new DatabaseSync(statePath);
  original.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  original.close();
  copyFileSync(statePath, backup);

  let effects = 0;
  const execute = async () => ++effects;
  await assert.rejects(executeApprovedLocalTool({ ...request, execute }), { code: "STATE_UNAVAILABLE" });
  const results = await Promise.allSettled([
    executeApprovedLocalTool({ ...request, witness, execute }),
    executeApprovedLocalTool({ ...request, statePath: other, witness, execute }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(effects, 1);
  copyFileSync(backup, statePath);
  assert.equal((await readLocalOperationStatus(operationId, statePath)).state, "APPROVED");
  await assert.rejects(executeApprovedLocalTool({ ...request, witness, execute }), { code: "UNKNOWN" });
  assert.equal((await readLocalOperationStatus(operationId, statePath)).state, "UNKNOWN");
  assert.equal(effects, 1);
});

test("witness uncertainty or lease loss never falls through to dispatch", async t => {
  const { statePath } = fixture(t);
  const id = "witness";
  await provisionLocalLedger(statePath, { witnessId: id });
  const request = { statePath, intent, effect };
  await approveLocalToolIntent(request);
  let effects = 0;
  let completeReservation;
  const waiting = new Promise(resolve => { completeReservation = resolve; });
  const execute = async () => ++effects;
  await assert.rejects(executeApprovedLocalTool({
    ...request, execute, leaseMs: 10, witness: { id, reserve: async () => waiting },
  }), { code: "UNKNOWN" });
  completeReservation(true);
  await assert.rejects(executeApprovedLocalTool({
    ...request, execute, witness: { id, reserve: async () => true },
  }), { code: "UNKNOWN" });
  assert.equal(effects, 0);
});

test("PostgreSQL witness uses one parameterised, durable reservation statement", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: calls.length === 1 ? 1 : 0 };
    },
  };
  const witness = createPostgresAdmissionWitness(client, "authority");
  assert.equal(await witness.reserve("operation", "effect"), true);
  assert.equal(await witness.reserve("operation", "different-effect"), false);
  assert.deepEqual(calls[0].params, ["authority", "operation", "effect"]);
  assert.match(calls[0].sql, /ON CONFLICT \(authority_id, operation_id\) DO NOTHING/);
  const invalid = createPostgresAdmissionWitness({ query: async () => ({ rowCount: null }) }, "authority");
  await assert.rejects(invalid.reserve("operation", "effect"), { code: "STATE_UNAVAILABLE" });
});

test("a separately approved cancellation invalidates an older approved amendment at the provider", async t => {
  const { dir, statePath } = fixture(t);
  await provisionLocalLedger(statePath);
  const provider = new DatabaseSync(join(dir, "booking-provider.sqlite"));
  t.after(() => provider.close());
  provider.exec(`
    CREATE TABLE reservation (id INTEGER PRIMARY KEY, version INTEGER, status TEXT);
    CREATE TABLE effects (action TEXT NOT NULL);
    INSERT INTO reservation VALUES (1, 1, 'ACTIVE');
    CREATE TRIGGER observed_effect AFTER UPDATE ON reservation
    BEGIN
      INSERT INTO effects VALUES (NEW.status);
    END;
  `);
  const approval = action => ({
    statePath,
    intent: { ...intent, intentId: action },
    effect: { tool: `booking.${action}`, args: { reservationId: 1, expectedVersion: 1 } },
  });
  const amendment = approval("amend");
  const cancellation = approval("cancel");
  await approveLocalToolIntent(amendment);
  await approveLocalToolIntent(cancellation);
  const conditionalWrite = async ({ tool, args }) => {
    const status = tool === "booking.cancel" ? "CANCELLED" : "AMENDED";
    const result = provider.prepare(
      "UPDATE reservation SET version=version+1,status=? WHERE id=? AND version=? AND status='ACTIVE'",
    ).run(status, args.reservationId, args.expectedVersion);
    return { outcome: result.changes === 1 ? status : "STALE_VERSION" };
  };
  assert.deepEqual(await executeApprovedLocalTool({ ...cancellation, execute: conditionalWrite }), { outcome: "CANCELLED" });
  assert.deepEqual(await executeApprovedLocalTool({ ...amendment, execute: conditionalWrite }), { outcome: "STALE_VERSION" });
  assert.deepEqual(provider.prepare("SELECT action FROM effects").all().map(record => record.action), ["CANCELLED"]);
});

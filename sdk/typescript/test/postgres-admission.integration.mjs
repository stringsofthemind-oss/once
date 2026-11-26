import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { approveLocalToolIntent, provisionLocalLedger } from "../dist/index.js";

const pgModule = process.env.ONCE_TEST_PG_MODULE || "pg";
const pgUrl = process.env.ONCE_TEST_POSTGRES_URL;
const { Pool } = (await import(pgModule)).default;
const sdk = new URL("../dist/index.js", import.meta.url).href;

const worker = `
  import { DatabaseSync } from "node:sqlite";
  const [sdk, pgModule, providerPath, input] = process.argv.slice(1);
  const { executeApprovedLocalTool, createPostgresAdmissionWitness } = await import(sdk);
  const { Pool } = (await import(pgModule)).default;
  const pool = new Pool({
    connectionString: process.env.ONCE_TEST_POSTGRES_URL,
    options: "-c role=once_admission_runner",
  });
  const { statePath, effect, intent } = JSON.parse(input);
  try {
    const receipt = await executeApprovedLocalTool({
      statePath, effect, intent, witness: createPostgresAdmissionWitness(pool, "isolated-proof"),
      execute: async (_effect, { operationId }) => {
        const provider = new DatabaseSync(providerPath, { timeout: 5000 });
        try {
          return { providerId: Number(provider.prepare("INSERT INTO effects (operation_id) VALUES (?)")
            .run(operationId).lastInsertRowid) };
        } finally {
          provider.close();
        }
      },
    });
    console.log(JSON.stringify({ outcome: "CONFIRMED", receipt }));
  } catch (error) {
    console.log(JSON.stringify({ outcome: error.code, message: error.message }));
  } finally {
    await pool.end();
  }
`;

test("PostgreSQL admission spans processes and survives valid local ledger rollback", async t => {
  assert.ok(pgUrl, "Set ONCE_TEST_POSTGRES_URL to a dedicated empty test database.");
  const pool = new Pool({ connectionString: pgUrl });
  t.after(() => pool.end());
  const sql = await readFile(new URL("../sql/admission-witness.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query("INSERT INTO once_admission.authorities VALUES ('isolated-proof')");
  await pool.query(`
    CREATE ROLE once_admission_runner;
    GRANT USAGE ON SCHEMA once_admission TO once_admission_runner;
    GRANT SELECT ON once_admission.authorities TO once_admission_runner;
    GRANT INSERT, SELECT (authority_id, operation_id)
      ON once_admission.reservations TO once_admission_runner;
  `);

  const dir = mkdtempSync(join(tmpdir(), "once-postgres-admission-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerA = join(dir, "a.sqlite");
  const ledgerB = join(dir, "b.sqlite");
  const backups = [join(dir, "before-a.sqlite"), join(dir, "before-b.sqlite")];
  const providerPath = join(dir, "provider.sqlite");
  const provider = new DatabaseSync(providerPath);
  t.after(() => provider.close());
  provider.exec("CREATE TABLE effects (id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL)");
  const intent = { tenant: "test-tenant", providerAccount: "test-provider", intentId: "approve-1" };
  const effect = { tool: "test.booking", args: { version: 1 } };

  const ledgers = [ledgerA, ledgerB];
  for (const [index, statePath] of ledgers.entries()) {
    await provisionLocalLedger(statePath, { witnessId: "isolated-proof" });
    await approveLocalToolIntent({ statePath, intent, effect });
    const source = new DatabaseSync(statePath, { readOnly: true });
    try { await backup(source, backups[index]); } finally { source.close(); }
  }

  const attempt = async statePath => {
    const result = await promisify(execFile)(process.execPath,
      ["--input-type=module", "-e", worker, sdk, pgModule, providerPath, JSON.stringify({ statePath, effect, intent })],
      { timeout: 20_000 });
    return JSON.parse(result.stdout);
  };
  const outcomes = await Promise.all(ledgers.map(attempt));
  assert.deepEqual(outcomes.map(result => result.outcome).sort(), ["CONFIRMED", "UNKNOWN"]);
  const winner = outcomes.findIndex(result => result.outcome === "CONFIRMED");
  copyFileSync(backups[winner], ledgers[winner]);
  assert.equal((await attempt(ledgers[winner])).outcome, "UNKNOWN");
  const { rows } = await pool.query("SELECT operation_id FROM once_admission.reservations");
  assert.deepEqual(rows, provider.prepare("SELECT operation_id FROM effects").all().map(row => ({ ...row })));
  assert.equal(rows.length, 1);
});

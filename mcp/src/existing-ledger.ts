import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { LocalProtectionError } from "@once-agent/sdk";
import { createLocalProtectionSession } from "@once-agent/sdk/connect";

/** Admission only: no schema creation, migration, repair or second state machine. */
export async function openExistingLedger(statePath: string) {
  const fail = () => new LocalProtectionError("STATE_UNAVAILABLE", "Restore the original valid host-provisioned ledger; no dispatch is permitted.");
  if (!isAbsolute(statePath)) throw fail();
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 15)) throw new LocalProtectionError("UNSUPPORTED_RUNTIME", "Node 24.15+ is required.");
  const { DatabaseSync } = await import("node:sqlite");
  let guard: InstanceType<typeof DatabaseSync> | undefined;
  const session = createLocalProtectionSession(statePath);
  try {
    const initial = statSync(statePath, { bigint: true });
    if (!initial.isFile() || initial.size === 0n) throw fail();
    guard = new DatabaseSync(statePath, { readOnly: true });
    let schemaVersion: unknown;
    let invalidated = false;
    const assertValid = () => {
      try {
        if (invalidated) throw fail();
        const current = statSync(statePath, { bigint: true });
        if (current.dev !== initial.dev || current.ino !== initial.ino || current.birthtimeNs !== initial.birthtimeNs) throw fail();
        const version = guard!.prepare("PRAGMA schema_version").get()!.schema_version;
        if (schemaVersion !== undefined && schemaVersion !== version) throw fail();
        const columns = guard!.prepare("PRAGMA table_info(local_operations)").all();
        const expected = [["id", "TEXT", 0, 1], ["fingerprint", "TEXT", 1, 0], ["state", "TEXT", 1, 0], ["result_json", "TEXT", 0, 0], ["owner", "TEXT", 0, 0], ["lease_until", "INTEGER", 0, 0]];
        if (JSON.stringify(columns.map(x => [x.name, x.type, x.notnull, x.pk])) !== JSON.stringify(expected)) throw fail();
        const schema = String(guard!.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='local_operations'").get()!.sql).replace(/\s+/g, "").toUpperCase();
        if (!schema.includes("CHECK(STATEIN('CLAIMED','UNKNOWN','CONFIRMED'))")) throw fail();
        if (guard!.prepare("PRAGMA quick_check").all().some(row => row.quick_check !== "ok")) throw fail();
        if (guard!.prepare("SELECT id FROM local_operations WHERE id IS NULL OR typeof(id)!='text' OR typeof(fingerprint)!='text' OR state NOT IN ('CLAIMED','UNKNOWN','CONFIRMED') LIMIT 1").get()) throw fail();
        schemaVersion = version;
      } catch { invalidated = true; session.close(); throw fail(); }
    };
    assertValid(); // Reject missing schema BEFORE the SDK's initializing open.
    await session.databaseForCall();
    assertValid(); // Reject startup races/schema repair before tool registration.
    return {
      session,
      assertValid,
      close: () => { session.close(); guard?.close(); guard = undefined; },
    };
  } catch {
    session.close(); guard?.close(); throw fail();
  }
}

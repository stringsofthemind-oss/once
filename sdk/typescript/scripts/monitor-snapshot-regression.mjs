import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = await mkdtemp(
  path.join(os.tmpdir(), "once-monitor-snapshot-")
);

const secret = "monitor-regression-secret-do-not-leak";

try {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "monitor-regression-project",
      private: true,
      type: "module"
    }, null, 2)
  );

  await writeFile(
    path.join(root, "agent.ts"),
    [
      "async function charge_card() { return 'ok'; }",
      "async function search_web() { return 'ok'; }",
      "const tools = [charge_card, search_web];",
      "void tools;"
    ].join("\n")
  );

  await mkdir(path.join(root, ".cursor"), { recursive: true });
  await writeFile(
    path.join(root, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        billing: {
          command: "node",
          args: ["server.mjs"],
          env: {
            API_KEY: secret
          }
        }
      }
    }, null, 2)
  );

  const cli = path.resolve("dist/monitor-cli.js");
  const run = spawnSync(
    process.execPath,
    [cli, "snapshot", root],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        // Keep discovery deterministic: user-level host configs must not be
        // necessary for this proof and their contents must never be emitted.
        APPDATA: path.join(root, "appdata")
      }
    }
  );

  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.stderr, "");

  const snapshot = JSON.parse(run.stdout);
  assert.equal(snapshot.schema, "once.monitor.snapshot.v1");
  assert.equal(snapshot.project.name, path.basename(root));
  assert.equal(snapshot.privacy.localReadOnly, true);
  assert.equal(snapshot.privacy.sourceUploaded, false);
  assert.equal(snapshot.privacy.secretValuesIncluded, false);
  assert.equal(snapshot.privacy.payloadsIncluded, false);
  assert.equal(snapshot.privacy.absolutePathsIncluded, false);
  assert.equal(snapshot.capabilities.chronologicalActivityFeed, false);

  assert.ok(snapshot.summary.toolsDiscovered >= 2);
  assert.ok(snapshot.summary.configuredSources >= 1);
  assert.ok(snapshot.tools.some(tool => tool.name === "charge_card"));
  assert.ok(snapshot.tools.some(tool => tool.name === "search_web"));

  const charge = snapshot.tools.find(tool => tool.name === "charge_card");
  assert.equal(charge.effectClass, "MONEY_MOVEMENT");
  assert.ok(
    charge.action === "PROTECT_PRIORITY" ||
    charge.action === "CRITICAL_GAP"
  );

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes("server.mjs"), false);
  assert.equal(serialized.includes("API_KEY"), false);
  assert.equal(serialized.includes("\"description\""), false);
  assert.equal(serialized.includes("\"reasons\""), false);
  assert.equal(serialized.includes("\"configPath\""), false);
  assert.equal(serialized.includes("\"command\""), false);
  assert.equal(serialized.includes("\"args\""), false);
  assert.equal(serialized.includes("\"env\""), false);

  const rejected = spawnSync(
    process.execPath,
    [cli, "snapshot", root, "--tools-live=cursor/billing"],
    { encoding: "utf8" }
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not accept network, live-probe, or payload flags/);

  console.log("PASS: Once Monitor snapshot is local, deterministic, and secret-minimal.");
} finally {
  await rm(root, { recursive: true, force: true });
}

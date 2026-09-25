import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  discoverToolGraph
} from "../dist/tool-discovery.js";

const root =
  await mkdtemp(
    path.join(
      os.tmpdir(),
      "once-tool-discovery-"
    )
  );

try {
  await mkdir(
    path.join(root, ".cursor"),
    { recursive: true }
  );

  await mkdir(
    path.join(root, "src"),
    { recursive: true }
  );

  const cursorConfig = [
    "{",
    "  // JSONC comments should be accepted.",
    '  "mcpServers": {',
    '    "stripe": {',
    '      "command": "npx",',
    '      "args": ["-y", "@example/stripe-mcp"],',
    '      "env": { "STRIPE_SECRET_KEY": "sk_test_super_secret_fixture" }',
    "    },",
    '    "docs": {',
    '      "url": "https://example.invalid/mcp"',
    "    }",
    "  }",
    "}",
    ""
  ].join("\n");

  await writeFile(
    path.join(root, ".cursor", "mcp.json"),
    cursorConfig,
    "utf8"
  );

  await writeFile(
    path.join(root, "pyproject.toml"),
    [
      "[project]",
      'name = "tool-discovery-fixture"',
      'version = "0.0.0"',
      'dependencies = ["openai"]',
      ""
    ].join("\n"),
    "utf8"
  );

  const sourcePath =
    path.join(root, "src", "agent_tools.py");

  const source = [
    "@tool",
    "def search(query):",
    "    return query",
    "",
    "@tool",
    "def refund_payment(order_id):",
    "    return stripe.refunds.create({\"order_id\": order_id})",
    ""
  ].join("\n");

  await writeFile(
    sourcePath,
    source,
    "utf8"
  );

  const result =
    await discoverToolGraph(root);

  const stripeSource =
    result.configuredSources.find(
      item =>
        item.host === "cursor" &&
        item.name === "stripe"
    );

  const docsSource =
    result.configuredSources.find(
      item =>
        item.host === "cursor" &&
        item.name === "docs"
    );

  assert.ok(stripeSource);
  assert.equal(
    stripeSource.transport,
    "STDIO"
  );
  assert.equal(
    stripeSource.status,
    "CONFIGURED_NOT_PROBED"
  );

  assert.ok(docsSource);
  assert.equal(
    docsSource.transport,
    "HTTP"
  );

  const serialized =
    JSON.stringify(result);

  assert.doesNotMatch(
    serialized,
    /sk_test_super_secret_fixture/
  );
  assert.doesNotMatch(
    serialized,
    /STRIPE_SECRET_KEY/
  );

  const refund =
    result.tools.find(
      tool =>
        tool.canonicalName === "refund_payment"
    );

  assert.ok(refund);
  assert.equal(
    refund.once.effectClass,
    "MONEY_MOVEMENT"
  );
  assert.equal(
    refund.once.criticality.band,
    "I5"
  );
  assert.equal(
    refund.once.actionPriority.band,
    "CRITICAL_GAP"
  );

  const search =
    result.tools.find(
      tool =>
        tool.canonicalName === "search"
    );

  assert.ok(search);
  assert.equal(
    search.once.effectClass,
    "READ_ONLY"
  );
  assert.equal(
    search.once.criticality.band,
    "I0"
  );
  assert.equal(
    search.once.actionPriority.band,
    "BYPASS"
  );

  const env = { ...process.env };
  delete env.ONCE_API_KEY;

  const cli =
    spawnSync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "doctor",
        root,
        "--tools"
      ],
      {
        encoding: "utf8",
        env
      }
    );

  assert.equal(
    cli.status,
    0,
    `doctor --tools should succeed\nstdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`
  );

  assert.match(
    cli.stdout,
    /TOOL DISCOVERY/
  );
  assert.match(
    cli.stdout,
    /cursor\/stripe/
  );
  assert.match(
    cli.stdout,
    /CONFIGURED_NOT_PROBED/
  );
  assert.match(
    cli.stdout,
    /CRITICAL GAPS/
  );
  assert.match(
    cli.stdout,
    /refund_payment/
  );
  assert.match(
    cli.stdout,
    /BYPASS \/ READ-ONLY/
  );
  assert.match(
    cli.stdout,
    /search/
  );
  assert.doesNotMatch(
    cli.stdout,
    /sk_test_super_secret_fixture/
  );
  assert.doesNotMatch(
    cli.stdout,
    /STRIPE_SECRET_KEY/
  );

  assert.equal(
    await readFile(sourcePath, "utf8"),
    source,
    "doctor --tools must not modify source files"
  );

  console.log("tool discovery regression: PASS");
} finally {
  await rm(
    root,
    {
      recursive: true,
      force: true
    }
  );
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  connectLocalGatewayToolsetAuto,
} from "../../dist/gateway/index.js";

test("gateway keeps direct tools direct and protected retries single-effect", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "once-gateway-local-"));
  const statePath = path.join(directory, "operations.sqlite");

  let searchCalls = 0;
  let sendEffects = 0;

  try {
    const registry = {
      search_orders: {
        async execute(input) {
          searchCalls += 1;
          return { query: input.query };
        },
      },
      send_email: {
        async execute(input) {
          sendEffects += 1;
          return {
            receipt: `sent:${input.to}:${input.body}`,
          };
        },
      },
    };

    const gateway = connectLocalGatewayToolsetAuto(registry, {
      manifest: [
        {
          name: "search_orders",
          description: "Search customer orders",
          inputSchema: { type: "object" },
        },
        {
          name: "send_email",
          description: "Sends an external customer email",
          inputSchema: {
            type: "object",
            properties: {
              idempotencyKey: { type: "string" },
              to: { type: "string" },
              body: { type: "string" },
            },
          },
        },
      ],
      statePath,
    });

    assert.deepEqual(
      gateway.plan.entries.map(entry => entry.route),
      ["DIRECT", "PROTECT"],
    );

    assert.deepEqual(
      await gateway.tools.search_orders.execute({ query: "open" }),
      { query: "open" },
    );
    assert.equal(searchCalls, 1);

    const input = {
      idempotencyKey: "intent-email-001",
      to: "customer@example.test",
      body: "hello",
    };

    const first = await gateway.tools.send_email.execute(input);
    const retry = await gateway.tools.send_email.execute({ ...input });

    assert.deepEqual(first, retry);
    assert.equal(sendEffects, 1);

    await assert.rejects(
      gateway.tools.send_email.execute({
        ...input,
        body: "changed body",
      }),
      error => error?.code === "CONFLICT",
    );
    assert.equal(sendEffects, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

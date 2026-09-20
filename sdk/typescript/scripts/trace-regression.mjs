import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  traceFetch
} from "../dist/trace.js";

const tempRoot = await mkdtemp(
  join(tmpdir(), "once-trace-regression-")
);

const tracePath = join(
  tempRoot,
  "agent-trace.jsonl"
);

let payload = "alpha";

const server = createServer((request, response) => {
  response.statusCode = 200;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("etag", `\"${payload}\"`);
  response.end(payload);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  const url = `http://127.0.0.1:${address.port}/state`;

  const first = await traceFetch(
    url,
    {
      tracePath,
      resource: "test:state"
    }
  );

  const expectedAlpha = createHash("sha256")
    .update("alpha")
    .digest("hex");

  assert.equal(first.status, 200);
  assert.equal(first.ok, true);
  assert.equal(first.observation.fingerprint, expectedAlpha);
  assert.equal(first.observation.response_bytes, 5);
  assert.equal(first.observation.once_decision, undefined);

  payload = "beta";

  const second = await traceFetch(
    url,
    {
      tracePath,
      resource: "test:state"
    }
  );

  const expectedBeta = createHash("sha256")
    .update("beta")
    .digest("hex");

  assert.equal(second.observation.fingerprint, expectedBeta);
  assert.equal(second.observation.response_bytes, 4);
  assert.equal(second.observation.once_decision, undefined);

  const lines = (await readFile(tracePath, "utf8"))
    .trim()
    .split(/\r?\n/u)
    .map(line => JSON.parse(line));

  assert.equal(lines.length, 2);
  assert.equal(lines[0].resource, "test:state");
  assert.equal(lines[1].resource, "test:state");
  assert.equal("once_decision" in lines[0], false);
  assert.equal("once_decision" in lines[1], false);
  assert.equal(lines[0].metadata.collector, "once-trace-fetch-v1");
  assert.equal(lines[1].metadata.collector, "once-trace-fetch-v1");

  console.log("Trace regression: PASS");
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(tempRoot, {
    recursive: true,
    force: true
  });
}

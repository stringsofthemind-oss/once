import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  inspectProtectionReceipt,
  writeProtectionReceipt,
} from "../dist/protection-receipt.js";
import {
  verifyProtectionRoute,
} from "../dist/protection-route-proof.js";

const root = await mkdtemp(
  path.join(os.tmpdir(), "once-sdk-route-proof-")
);

async function createAppliedProject(name) {
  const directory = path.join(root, name);
  const src = path.join(directory, "src");
  await mkdir(src, { recursive: true });

  const sourcePath = path.join(src, "action.ts");
  const source = [
    'import { Once } from "@once-agent/sdk";',
    "export async function action(operationId, payload) {",
    "  return new Once().execute({ operationId, provider: 'demo', action: payload });",
    "}",
    "",
  ].join("\n");

  await writeFile(sourcePath, source, "utf8");

  const crypto = await import("node:crypto");
  const sha = crypto.createHash("sha256")
    .update(source, "utf8")
    .digest("hex");

  await writeProtectionReceipt(
    directory,
    {
      callsiteRef: `callsite-${name}`,
      file: "src/action.ts",
      provider: "configured-app-provider",
      sourceSha256: "0".repeat(64),
      appliedSha256: sha,
    },
  );

  return {
    directory,
    sourcePath,
    source,
  };
}

function createFakeOnceFetch({ duplicateEffects = false } = {}) {
  let attempts = 0;
  let sideEffects = 0;
  let operationId = null;
  const calls = [];

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    );

    const method = String(init.method || "GET").toUpperCase();
    calls.push({ method, pathname: url.pathname });

    assert.equal(
      init.headers.authorization,
      "Bearer once_test_route_proof",
      "proof must authenticate through the normal SDK request path"
    );

    if (method === "POST" && url.pathname === "/v1/execute") {
      const body = JSON.parse(init.body);
      assert.equal(body.provider, "blind_test");
      assert.equal(body.action.type, "once_sdk_execute_route_proof_v1");
      assert.equal(body.action.synthetic, true);

      if (operationId === null) {
        operationId = body.operation_id;
      }
      assert.equal(body.operation_id, operationId);

      attempts++;
      if (duplicateEffects || sideEffects === 0) {
        sideEffects++;
      }

      return Response.json({
        operation_id: operationId,
        result: attempts === 1 ? "executed" : "replayed",
        state: "CONFIRMED",
        ledger_state: "CONFIRMED",
        attempts,
        side_effects: sideEffects,
        provider_executed: true,
      });
    }

    if (method === "GET" && url.pathname.startsWith("/v1/truth/")) {
      return Response.json({
        operation_id: operationId,
        ledger_state: "CONFIRMED",
        state: "CONFIRMED",
        attempts,
        side_effects: sideEffects,
        provider_executed: sideEffects > 0,
      });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  };

  return {
    fetchImpl,
    calls,
    get attempts() { return attempts; },
    get sideEffects() { return sideEffects; },
  };
}

try {
  const success = await createAppliedProject("success");
  const fake = createFakeOnceFetch();

  const result = await verifyProtectionRoute(
    success.directory,
    {
      apiKey: "once_test_route_proof",
      baseUrl: "https://once.test",
      fetchImpl: fake.fetchImpl,
      operationId: "phase15-sdk-proof:test-success",
    },
  );

  assert.equal(result.passed, true);
  assert.equal(result.executeRequests, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.sideEffects, 1);
  assert.equal(result.ledgerState, "CONFIRMED");
  assert.equal(fake.attempts, 2);
  assert.equal(fake.sideEffects, 1);

  const protectedReceipt = JSON.parse(
    await readFile(
      path.join(success.directory, ".once", "protection-status.json"),
      "utf8",
    ),
  );

  assert.equal(protectedReceipt.status, "PROTECTED");
  assert.equal(protectedReceipt.once_protected, true);
  assert.equal(protectedReceipt.execution_route, "ONCE_SDK_EXECUTE_V1");
  assert.equal(protectedReceipt.route_proof.required, "ONCE_EXECUTE_LOST_ACK_REPLAY_V1");
  assert.equal(protectedReceipt.route_proof.state, "PASS");
  assert.equal(protectedReceipt.route_proof.operation_id, "phase15-sdk-proof:test-success");
  assert.equal(protectedReceipt.route_proof.attempts, 2);
  assert.equal(protectedReceipt.route_proof.side_effects, 1);
  assert.match(protectedReceipt.route_proof.verified_at, /^\d{4}-\d{2}-\d{2}T/);

  const inspection = await inspectProtectionReceipt(success.directory);
  assert.equal(inspection.state, "CURRENT_PROTECTED");

  const callCountBeforeIdempotentVerify = fake.calls.length;
  const replayedProof = await verifyProtectionRoute(
    success.directory,
    {
      apiKey: "once_test_route_proof",
      baseUrl: "https://once.test",
      fetchImpl: fake.fetchImpl,
    },
  );
  assert.equal(replayedProof.passed, true);
  assert.equal(
    fake.calls.length,
    callCountBeforeIdempotentVerify,
    "an already verified current receipt must not repeat the network proof"
  );

  await writeFile(
    success.sourcePath,
    success.source + "// changed after verification\n",
    "utf8",
  );

  await assert.rejects(
    verifyProtectionRoute(
      success.directory,
      {
        apiKey: "once_test_route_proof",
        baseUrl: "https://once.test",
        fetchImpl: fake.fetchImpl,
      },
    ),
    /Protection receipt is stale/,
  );

  const failure = await createAppliedProject("duplicate-failure");
  const broken = createFakeOnceFetch({ duplicateEffects: true });

  await assert.rejects(
    verifyProtectionRoute(
      failure.directory,
      {
        apiKey: "once_test_route_proof",
        baseUrl: "https://once.test",
        fetchImpl: broken.fetchImpl,
        operationId: "phase15-sdk-proof:test-duplicate",
      },
    ),
    /exactly one synthetic provider effect/,
  );

  const failedInspection = await inspectProtectionReceipt(failure.directory);
  assert.equal(
    failedInspection.state,
    "CURRENT_PENDING_PROOF",
    "failed hostile-retry proof must not promote the protection receipt"
  );

  console.log("protection route proof regression: PASS");
} finally {
  await rm(root, { recursive: true, force: true });
}
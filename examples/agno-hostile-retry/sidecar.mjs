import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { connectLocalAgentToolAuto } from "@once-agent/sdk/connect";

const port = Number(process.env.ONCE_AGNO_PORT || "8920");
const mode = process.env.ONCE_AGNO_MODE === "once" ? "once" : "control";
const ledgerPath = process.env.ONCE_AGNO_LEDGER_PATH || path.resolve("agno-effects.jsonl");
const statePath = process.env.ONCE_AGNO_STATE_PATH || path.resolve("agno-once-state.sqlite");

let requestCount = 0;

fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

function readEffects() {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function commitCharge(input) {
  const effect = {
    operationId: input.operationId,
    amount: input.amount,
    cardRef: input.cardRef,
    committedAt: new Date().toISOString(),
  };

  fs.appendFileSync(ledgerPath, `${JSON.stringify(effect)}\n`, "utf8");

  return {
    status: "charged",
    operationId: input.operationId,
    amount: input.amount,
    cardRef: input.cardRef,
    effectNumber: readEffects().length,
  };
}

const rawTool = {
  execute: commitCharge,
};

const protectedTool = connectLocalAgentToolAuto(rawTool, {
  descriptor: {
    name: "charge_card",
    description: "Charges a payment card and changes external state.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  id: (input) => input.operationId,
  payload: (input) => ({
    amount: input.amount,
    cardRef: input.cardRef,
  }),
  statePath,
});

const selectedTool = mode === "once" ? protectedTool : rawTool;

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true, mode });
    }

    if (req.method === "GET" && req.url === "/stats") {
      return sendJson(res, 200, {
        mode,
        requests: requestCount,
        effects: readEffects().length,
        ledgerPath,
        statePath: mode === "once" ? statePath : null,
      });
    }

    if (req.method === "POST" && req.url === "/charge") {
      requestCount += 1;
      const body = await readJson(req);

      if (
        typeof body.operationId !== "string" ||
        body.operationId.trim() === "" ||
        typeof body.amount !== "string" ||
        typeof body.cardRef !== "string"
      ) {
        return sendJson(res, 400, { error: "invalid_charge_request" });
      }

      const result = await selectedTool.execute({
        operationId: body.operationId,
        amount: body.amount,
        cardRef: body.cardRef,
      });

      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error",
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `${JSON.stringify({ ready: true, port, mode, sdk: "@once-agent/sdk@0.1.12" })}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

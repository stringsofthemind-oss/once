import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapTool } from "@once-agent/sdk";
const input = { refundId: "invoice_456", customerId: "customer_123", amount: 5000, currency: "GBP" };
const rows = (directory) => readFileSync(path.join(directory, "provider.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
async function worker(mode, directory, origin) {
    const dispatch = async (args) => {
        const response = await fetch(`${origin}/refund`, { method: "POST", body: JSON.stringify(args), signal: AbortSignal.timeout(5000) });
        if (!response.ok)
            throw new Error(`Provider HTTP ${response.status}`);
        return await response.json();
    };
    if (mode === "naive") {
        await assert.rejects(dispatch(input));
        return;
    }
    const refund = wrapTool(dispatch, {
        operationId: args => `demo-tenant:refund:${args.refundId}`,
        effect: args => ({ tool: "local-demo-provider:demo-account:refund", args }),
        statePath: path.join(directory, "operations.sqlite"),
        ...(mode === "reconcile" || mode === "replay" || mode === "unavailable" || mode === "absent" ? { reconcile: async () => {
                if (mode === "absent")
                    return { status: "NOT_FOUND" };
                if (mode === "unavailable")
                    return { status: "UNKNOWN" };
                const response = await fetch(`${origin}/truth`, { signal: AbortSignal.timeout(5000) });
                if (!response.ok)
                    return { status: "UNKNOWN" };
                const receipts = await response.json();
                const matches = receipts.filter(row => JSON.stringify(row.input) === JSON.stringify(input));
                return matches.length === 1 ? { status: "CONFIRMED", result: matches[0] } : { status: "UNKNOWN" };
            } } : {}),
    });
    if (["lost", "blocked", "unavailable", "absent"].includes(mode))
        await assert.rejects(refund(input), { code: "UNKNOWN" });
    else if (mode === "conflict")
        await assert.rejects(refund({ ...input, amount: 8000 }), { code: "CONFLICT" });
    else {
        const receipt = await refund(input);
        assert.ok(receipt);
        assert.equal(receipt.receipt, "refund_1");
        assert.deepEqual(receipt.input, input);
    }
}
async function provider(directory, loseAck) {
    writeFileSync(path.join(directory, "provider.jsonl"), "");
    const server = createServer(async (request, response) => {
        if (request.method === "GET" && request.url === "/truth") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(rows(directory)));
            return;
        }
        if (request.method !== "POST" || request.url !== "/refund") {
            response.writeHead(404).end();
            return;
        }
        const chunks = [];
        for await (const chunk of request)
            chunks.push(Buffer.from(chunk));
        const args = JSON.parse(Buffer.concat(chunks).toString());
        const receipt = { receipt: `refund_${rows(directory).length + 1}`, input: args };
        appendFileSync(path.join(directory, "provider.jsonl"), JSON.stringify(receipt) + "\n", { flush: true });
        if (loseAck) {
            response.destroy();
            return;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(receipt));
    });
    server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address !== "string")
            process.send?.(`http://127.0.0.1:${address.port}`);
    });
}
const modulePath = fileURLToPath(import.meta.url);
async function runWorker(mode, directory, origin) {
    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [modulePath, "worker", mode, directory, origin], { stdio: ["ignore", "pipe", "pipe"] });
        let errors = "";
        child.stderr.on("data", chunk => { errors += String(chunk); });
        child.on("error", reject);
        const timer = setTimeout(() => { child.kill(); reject(new Error(`Worker ${mode} timed out`)); }, 15000);
        child.on("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Worker ${mode} failed: ${errors}`)); });
    });
}
export async function runFirst10Proof() {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 24 || (major === 24 && minor < 15))
        throw new Error("once prove requires Node.js 24.15+ for durable local SQLite.");
    const started = performance.now();
    const root = mkdtempSync(path.join(tmpdir(), "once-refund-proof-"));
    console.log("ONCE REFUND PROOF\nControlled local HTTP provider. No account, API key or money movement.");
    console.log(`Evidence: ${root}`);
    const report = {};
    for (const scenario of ["without-once", "confirmed", "lost-ack"]) {
        const directory = path.join(root, scenario);
        mkdirSync(directory);
        const observedCounts = [];
        const child = spawn(process.execPath, [modulePath, "provider", directory, String(scenario !== "confirmed")], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
        try {
            const origin = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Provider startup timed out")), 10000);
                child.once("message", value => { clearTimeout(timer); resolve(String(value)); });
                child.once("error", error => { clearTimeout(timer); reject(error); });
                child.once("exit", code => { clearTimeout(timer); reject(new Error(`Provider exited: ${code}`)); });
            });
            const count = async () => {
                const response = await fetch(`${origin}/truth`, { signal: AbortSignal.timeout(5000) });
                assert.equal(response.status, 200);
                const observed = await response.json();
                assert.deepEqual(observed, rows(directory));
                observedCounts.push(observed.length);
                return observed.length;
            };
            assert.equal(await count(), 0);
            if (scenario === "without-once") {
                await runWorker("naive", directory, origin);
                assert.equal(await count(), 1);
                await runWorker("naive", directory, origin);
                assert.equal(await count(), 2);
                console.log("WITHOUT ONCE: acknowledgement lost; fresh-process retry -> 2 provider writes");
                report[scenario] = { writes: 2, observedCounts };
            }
            else {
                const lost = scenario === "lost-ack";
                await runWorker(lost ? "lost" : "first", directory, origin);
                assert.equal(await count(), 1);
                await runWorker(lost ? "blocked" : "replay", directory, origin);
                assert.equal(await count(), 1);
                await runWorker("conflict", directory, origin);
                assert.equal(await count(), 1);
                if (lost) {
                    await runWorker("unavailable", directory, origin);
                    assert.equal(await count(), 1);
                    await runWorker("absent", directory, origin);
                    assert.equal(await count(), 1);
                    console.log("RETRY BLOCKED — ORIGINAL OUTCOME UNKNOWN\nThe refund may already have succeeded. Once sent no second request.\nNext action: read authoritative provider truth (demonstrated next).");
                    await runWorker("reconcile", directory, origin);
                    assert.equal(await count(), 1);
                    await runWorker("replay", directory, origin);
                    assert.equal(await count(), 1);
                }
                console.log(`${scenario.toUpperCase()}: 1 provider write; restart replay; changed £50 -> £80: CONFLICT, 0 additional writes${lost ? "; UNKNOWN -> CONFIRMED; recovered refund_1" : ""}`);
                report[scenario] = { writes: 1, observedCounts, conflictAdditionalWrites: 0, restart: true, ...(lost ? { initialStatus: "UNKNOWN", finalStatus: "CONFIRMED", unsafeRedispatches: 0, receipt: "refund_1" } : { replay: true }) };
            }
        }
        finally {
            if (child.exitCode === null) {
                const stopped = new Promise(resolve => child.once("exit", () => resolve()));
                child.kill();
                await stopped;
            }
        }
    }
    const seconds = Number(((performance.now() - started) / 1000).toFixed(2));
    writeFileSync(path.join(root, "report.json"), JSON.stringify({ scope: "controlled-local-http-provider", seconds, scenarios: report }, null, 2));
    console.log(`PASS (${seconds}s). Local proof only; this does not certify a real payment provider or your operation.\nApply the pattern: https://onceexec.com/quickstart/`);
    return { root, seconds, scenarios: report };
}
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
    const [, , role, a, b, c] = process.argv;
    if (role === "provider")
        await provider(a, b === "true");
    else if (role === "worker")
        await worker(a, b, c);
    else
        await runFirst10Proof();
}

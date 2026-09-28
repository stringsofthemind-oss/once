import { strict as assert } from "node:assert";
import { writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  transformHttpWriteV1,
  HTTP_WRITE_TRANSFORMER_ID
} from "../dist/transformers/http-write-v1.js";

console.log("\nONCE HTTP TRANSFORMER REGRESSION");
console.log("================================");

const goodFunction = `
export async function createOrder(operationId: string, payload: unknown) {
  await fetch("https://api.example.invalid/orders", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
`;

const goodStatement = `
await fetch("https://api.example.invalid/orders", {
  method: "POST",
  body: JSON.stringify(payload)
});
`;

function transform(statement, functionSource = goodFunction) {
  return transformHttpWriteV1({ statement, functionSource, provider: "customer-http" });
}

const good = transform(goodStatement);
assert.equal(good.eligible, true, "Known-safe fixture should be transformable");
if (!good.eligible) throw new Error(good.reason);
assert.equal(good.transformer, HTTP_WRITE_TRANSFORMER_ID);
assert.equal(good.actionType, "http_write_v1");
assert.equal(good.method, "POST");
assert.equal(good.url, "https://api.example.invalid/orders");
assert.equal(good.bodyExpression, "payload");
assert.match(good.replacement, /operationId/);
assert.match(good.replacement, /provider: "customer-http"/);
assert.match(good.replacement, /body_json: JSON\.stringify\(payload\)/);
console.log("PASS - baseline POST pattern transformed");

const jsonHeader = transform(`
await fetch("https://api.example.invalid/orders", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});
`);
assert.equal(jsonHeader.eligible, true, "Static JSON Content-Type header should be transformable");
if (!jsonHeader.eligible) throw new Error(jsonHeader.reason);
assert.equal(jsonHeader.url, good.url);
assert.equal(jsonHeader.bodyExpression, "payload");
assert.equal(jsonHeader.replacement, good.replacement, "Header form must map to the same proven Once action semantics");
console.log("PASS - static application/json Content-Type header transformed");

const jsonHeaderSingleQuotes = transform(`
await fetch('https://api.example.invalid/orders', {
  body: JSON.stringify(payload.order),
  headers: { 'Content-Type': 'application/json' },
  method: 'POST'
});
`);
assert.equal(jsonHeaderSingleQuotes.eligible, true, "Equivalent static JSON header syntax should be accepted");
if (!jsonHeaderSingleQuotes.eligible) throw new Error(jsonHeaderSingleQuotes.reason);
assert.equal(jsonHeaderSingleQuotes.bodyExpression, "payload.order");
console.log("PASS - option ordering and quote style preserve semantics");

const noOperationId = transform(goodStatement, `async function createOrder(payload: unknown) {}`);
assert.equal(noOperationId.eligible, false);
console.log("PASS - missing operationId rejected");

const returned = transform(`return await fetch("https://api.example.invalid/orders", { method: "POST", body: JSON.stringify(payload) });`);
assert.equal(returned.eligible, false);
console.log("PASS - returned fetch Response rejected");

const assigned = transform(`const response = await fetch("https://api.example.invalid/orders", { method: "POST", body: JSON.stringify(payload) });`);
assert.equal(assigned.eligible, false);
console.log("PASS - assigned fetch Response rejected");

const dynamicUrl = transform(`await fetch(endpoint, { method: "POST", body: JSON.stringify(payload) });`);
assert.equal(dynamicUrl.eligible, false);
console.log("PASS - dynamic URL rejected");

const authorizationHeader = transform(`
await fetch("https://api.example.invalid/orders", {
  method: "POST",
  headers: { "Authorization": "Bearer secret" },
  body: JSON.stringify(payload)
});
`);
assert.equal(authorizationHeader.eligible, false);
console.log("PASS - arbitrary headers rejected");

const extraJsonHeader = transform(`
await fetch("https://api.example.invalid/orders", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Trace": "1" },
  body: JSON.stringify(payload)
});
`);
assert.equal(extraJsonHeader.eligible, false);
console.log("PASS - JSON header plus additional header rejected");

const dynamicContentType = transform(`
await fetch("https://api.example.invalid/orders", {
  method: "POST",
  headers: { "Content-Type": contentType },
  body: JSON.stringify(payload)
});
`);
assert.equal(dynamicContentType.eligible, false);
console.log("PASS - dynamic Content-Type rejected");

const put = transform(`await fetch("https://api.example.invalid/orders", { method: "PUT", body: JSON.stringify(payload) });`);
assert.equal(put.eligible, false);
console.log("PASS - non-POST method rejected");

const rawBody = transform(`await fetch("https://api.example.invalid/orders", { method: "POST", body: payload });`);
assert.equal(rawBody.eligible, false);
console.log("PASS - unsupported body encoding rejected");

const noProvider = transformHttpWriteV1({ statement: goodStatement, functionSource: goodFunction, provider: "" });
assert.equal(noProvider.eligible, false);
console.log("PASS - missing provider rejected");

const syntaxFile = path.join(process.cwd(), ".transformer-syntax-test.mjs");
const executable = `
const calls = [];
const once = { async execute(input) { calls.push(input); return { state: "CONFIRMED" }; } };
const operationId = "op-transformer-proof";
const payload = { order: 123 };
async function run() {
${jsonHeader.replacement.split("\n").map(line => "  " + line).join("\n")}
}
await run();
if (calls.length !== 1) throw new Error("Expected exactly one Once call");
if (calls[0].operationId !== operationId) throw new Error("operationId was not preserved");
if (calls[0].provider !== "customer-http") throw new Error("provider was not preserved");
if (calls[0].action.body_json !== JSON.stringify(payload)) throw new Error("serialized body changed");
`;

await writeFile(syntaxFile, executable, "utf8");
try {
  await import(pathToFileURL(syntaxFile).href + `?t=${Date.now()}`);
} finally {
  await rm(syntaxFile, { force: true });
}

console.log("PASS - expanded generated replacement executes exactly once against fake Once binding");
console.log("\nONCE HTTP TRANSFORMER REGRESSION PASSED");

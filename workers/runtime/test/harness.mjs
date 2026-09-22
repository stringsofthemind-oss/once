// Executes the checked-in Worker against real SQLite, without network or Cloudflare.
// Models SQL transactions, not Cloudflare output gates or lifecycle scheduling.
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

export async function loadRuntime() {
  const source = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8'))
    .replace('import { DurableObject } from "cloudflare:workers";', '')
    .replace(/export \{[\s\S]*?\};\s*\/\/# sourceMappingURL=index.js.map\s*$/, 'globalThis.Runtime = Q18Truth; globalThis.worker = index_default;');
  const context = vm.createContext({
    DurableObject: class { constructor(ctx) { this.ctx = ctx; } },
    Response, Request, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
    crypto: webcrypto, btoa, atob, setTimeout, clearTimeout, AbortSignal,
    console: { log() {} },
    fetch: async () => { throw new Error('Unexpected network request'); }
  });
  vm.runInContext(source, context);
  return context;
}

export function storage(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  let alarm = null;
  return {
    db,
    sql: { exec(query, ...params) { return db.prepare(query).all(...params); } },
    transactionSync(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async sync() {},
    async getAlarm() { return alarm; },
    async setAlarm(value) { alarm = value; },
    async deleteAlarm() { alarm = null; }
  };
}

export function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

export function execute(runtime, operationId = 'race', extra = {}) {
  return runtime.fetch(new Request('https://local.test/execute', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation_id: operationId, provider: 'blind_test', ...extra })
  }));
}

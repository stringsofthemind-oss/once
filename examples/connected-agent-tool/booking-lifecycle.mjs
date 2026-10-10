// Independent durable mock-provider journal. Never contacts a booking service.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import {createHash} from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const [sdkArgument, output] = process.argv.slice(2);
assert(sdkArgument && output, 'Usage: node booking-lifecycle.mjs SDK_FILE_URL OUTPUT.json');
rmSync(output, {force: true});
const sdkUrl = sdkArgument === '--local' ? new URL('../../sdk/typescript/dist/index.js', import.meta.url).href : sdkArgument;
const root = mkdtempSync(join(tmpdir(), 'once-booking-lifecycle-'));
const db = new DatabaseSync(join(root, 'provider.sqlite'));
db.exec(`CREATE TABLE reservations(id INTEGER PRIMARY KEY, args TEXT, version INTEGER, status TEXT);
  CREATE TABLE effects(id INTEGER PRIMARY KEY, operation TEXT, args TEXT, receipt TEXT);
  CREATE TABLE attempts(id INTEGER PRIMARY KEY, operation TEXT);`);
const counts = () => ({effects: db.prepare('SELECT count(*) AS n FROM effects').get().n,
  attempts: db.prepare('SELECT count(*) AS n FROM attempts').get().n});
const visibility = new Map();
const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && req.url.startsWith('/lookup/')) {
    const operation = decodeURIComponent(req.url.slice('/lookup/'.length));
    const mode = visibility.get(operation);
    if (mode) return res.end(JSON.stringify(typeof mode === 'string' ? {status: mode} : mode));
    const rows = db.prepare('SELECT args,receipt FROM effects WHERE operation=? ORDER BY id').all(operation)
      .map(row => ({args: JSON.parse(row.args), receipt: JSON.parse(row.receipt)}));
    return res.end(JSON.stringify({status: rows.length ? 'FOUND' : 'NOT_FOUND', rows}));
  }
  if (req.method !== 'POST' || req.url !== '/booking') {res.statusCode = 404; return res.end('{}');}
  let body = ''; for await (const chunk of req) body += chunk;
  const {operationId, args} = JSON.parse(body);
  db.prepare('INSERT INTO attempts(operation) VALUES (?)').run(operationId);
  const current = args.reservationId === null ? undefined : db.prepare('SELECT * FROM reservations WHERE id=?').get(args.reservationId);
  let receipt;
  if (args.validUntil <= Date.now()) receipt = {status: 'REJECTED', reason: 'INVENTORY_EXPIRED'};
  else if (args.action !== 'create' && (!current || current.status !== 'ACTIVE' ||
    current.version !== args.expectedVersion || JSON.parse(current.args).tenant !== args.tenant)) {
    receipt = {status: 'REJECTED', reason: 'RESERVATION_VERSION_OR_AUTHORITY_MISMATCH'};
  } else {
    db.exec('BEGIN IMMEDIATE');
    try {
      let id, version;
      if (args.action === 'create') {
        id = Number(db.prepare("INSERT INTO reservations(args,version,status) VALUES (?,1,'ACTIVE')").run(JSON.stringify(args)).lastInsertRowid);
        version = 1;
      } else {
        id = args.reservationId; version = current.version + 1;
        db.prepare('UPDATE reservations SET args=?,version=?,status=? WHERE id=?')
          .run(JSON.stringify(args), version, args.action === 'cancel' ? 'CANCELLED' : 'ACTIVE', id);
      }
      receipt = {status: args.action === 'cancel' ? 'CANCELLED' : 'ACTIVE', reservationId: id, version, args};
      db.prepare('INSERT INTO effects(operation,args,receipt) VALUES (?,?,?)')
        .run(operationId, JSON.stringify(args), JSON.stringify(receipt));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Acceptance precedes response; overlapping callers can observe IN_FLIGHT.
  await new Promise(resolve => setTimeout(resolve, 100));
  res.end(JSON.stringify(receipt));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const providerUrl = `http://127.0.0.1:${server.address().port}`;
const base = {action: 'create', tenant: 'tenant-A', resource: 'room-A',
  startsAt: '2026-11-10T14:00:00Z', endsAt: '2026-11-10T15:00:00Z', timezone: 'Europe/London',
  participants: [{customerId: 'customer-1', name: 'Fixture Person'}],
  partySize: 1, priceMinor: 1200, currency: 'GBP', termsVersion: 'fixture-v1',
  validUntil: Date.now() + 3600000, reservationId: null, expectedVersion: null};
const statePath = join(root, 'once.sqlite');
const call = (intent, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('booking-boundary.mjs', import.meta.url))]);
  let stdout = '', stderr = '';
  const timer = setTimeout(() => {child.kill(); reject(Error('Booking worker timed out'));}, 15000);
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  child.on('error', reject);
  child.on('exit', code => {clearTimeout(timer); try {assert.equal(code, 0, stderr); resolve(JSON.parse(stdout));} catch (error) {reject(error);}});
  child.stdin.end(JSON.stringify({sdkUrl, providerUrl, statePath, intent, args, ...options}));
});
const evidence = {schema_version: 1, scope: 'controlled booking lifecycle; local same-machine authority',
  sdkUrl, sdkVersion: JSON.parse(readFileSync(new URL('../package.json',sdkUrl),'utf8')).version,
  hashes: Object.fromEntries([['lab',import.meta.url],['boundary',new URL('booking-boundary.mjs',import.meta.url)],['sdkEntry',sdkUrl]]
    .map(([name,url])=>[name,createHash('sha256').update(readFileSync(new URL(url))).digest('hex')])),
  node: process.version, platform: process.platform, probes: []};
const probe = async (name, intent, args, options, status, delta = 0) => {
  const before = counts(); const response = await call(intent, args, options); const after = counts();
  assert.equal(response.status, status, JSON.stringify(response)); assert.equal(after.effects - before.effects, delta);
  if (delta === 0 && status !== 'CONFIRMED') assert.equal(after.attempts, before.attempts);
  evidence.probes.push({name, before, after, response}); return response;
};
try {
  const created = await probe('create', 'create-1', base, {}, 'CONFIRMED', 1);
  const replay = await probe('fresh-process-create-replay', 'create-1', base, {expectedState: true}, 'CONFIRMED');
  assert.deepEqual(replay, created);
  for (const [field, value] of Object.entries({tenant: 'tenant-B', resource: 'room-B', timezone: 'UTC',
    startsAt: '2026-11-10T14:30:00Z', endsAt: '2026-11-10T16:00:00Z', participants: [{customerId: 'other', name: 'Other'}],
    priceMinor: 1300, currency: 'USD', termsVersion: 'v2', validUntil: base.validUntil + 1})) {
    await probe('drift-' + field, 'create-1', {...base, [field]: value}, {}, 'CONFLICT');
  }
  await probe('missing-identity', '', base, {}, 'IDENTITY_REQUIRED');
  await probe('missing-expected-state', 'create-1', base, {expectedState:true, statePath:join(root,'missing.sqlite')}, 'STATE_UNAVAILABLE');
  await probe('drift-party-size', 'create-1', {...base, partySize:2,
    participants:[...base.participants, {customerId:'customer-2', name:'Second Person'}]}, {}, 'CONFLICT');
  for (const args of [null, {...base, participants: []}, {...base, providerUrl: 'unreviewed'},
    {...base, timezone: 'not-a-zone'}, {...base, endsAt: base.startsAt}, {...base, action:'unknown'}]) {
    await probe('unsupported-effect', 'unsafe', args, {}, 'INVALID_BOOKING_EFFECT');
  }
  const modification = {...base, action: 'modify', reservationId: created.result.reservationId,
    expectedVersion: 1, endsAt: '2026-11-10T16:00:00Z'};
  const modified = await probe('modify', 'modify-1', modification, {}, 'CONFIRMED', 1);
  assert.deepEqual(await probe('modify-replay', 'modify-1', modification, {}, 'CONFIRMED'), modified);
  await probe('modify-target-drift', 'modify-1', {...modification, reservationId: 999}, {}, 'CONFLICT');
  await probe('modify-version-drift', 'modify-1', {...modification, expectedVersion: 2}, {}, 'CONFLICT');
  const cancellation = {...modification, action: 'cancel', expectedVersion: 2};
  const cancelled = await probe('cancel', 'cancel-1', cancellation, {}, 'CONFIRMED', 1);
  assert.equal(cancelled.result.status, 'CANCELLED');
  assert.deepEqual(await probe('cancel-replay', 'cancel-1', cancellation, {}, 'CONFIRMED'), cancelled);
  await probe('new-identical-intent', 'create-2', base, {}, 'CONFIRMED', 1);
  const expired = await probe('expired-inventory', 'expired-1', {...base, validUntil: 0}, {}, 'CONFIRMED');
  assert.deepEqual(expired.result, {status: 'REJECTED', reason: 'INVENTORY_EXPIRED'});
  const expiryAttempts = counts().attempts;
  assert.deepEqual(await probe('expired-inventory-replay', 'expired-1', {...base, validUntil:0}, {}, 'CONFIRMED'), expired);
  assert.equal(counts().attempts, expiryAttempts);
  const stale = await probe('stale-version', 'stale-1', modification, {}, 'CONFIRMED');
  assert.equal(stale.result.reason, 'RESERVATION_VERSION_OR_AUTHORITY_MISMATCH');
  for (const action of ['create', 'modify', 'cancel']) {
    const setup = await probe('lost-ack-setup-' + action, 'setup-' + action, base, {}, 'CONFIRMED', 1);
    const effect = action === 'create' ? base : {...base, action, reservationId: setup.result.reservationId, expectedVersion: 1};
    const intent = 'lost-' + action;
    await probe('lost-ack-' + action, intent, effect, {lostAck: true}, 'UNKNOWN', 1);
    await probe('restart-unknown-' + action, intent, effect, {}, 'UNKNOWN');
    visibility.set(intent, 'UNKNOWN');
    await probe('delayed-truth-' + action, intent, effect, {reconcile: true}, 'UNKNOWN');
    visibility.set(intent, 'NOT_FOUND');
    await probe('non-authoritative-absence-' + action, intent, effect, {reconcile: true}, 'UNKNOWN');
    visibility.delete(intent);
    const actual = db.prepare('SELECT args,receipt FROM effects WHERE operation=?').get(intent);
    const row = {args: JSON.parse(actual.args), receipt: JSON.parse(actual.receipt)};
    visibility.set(intent, {status: 'FOUND', rows: [{...row, args: {...row.args, resource:'wrong'}}]});
    await probe('mismatched-truth-' + action, intent, effect, {reconcile:true}, 'UNKNOWN');
    visibility.set(intent, {status: 'FOUND', rows: [row, row]});
    await probe('nonunique-truth-' + action, intent, effect, {reconcile:true}, 'UNKNOWN');
    visibility.delete(intent);
    const reconciled = await probe('exact-reconciliation-' + action, intent, effect, {reconcile: true}, 'CONFIRMED');
    assert.deepEqual(reconciled.result.args, effect);
    assert.deepEqual(await probe('reconciled-replay-' + action, intent, effect, {}, 'CONFIRMED'), reconciled);
  }
  const before = counts();
  const concurrent = await Promise.all(Array.from({length: 12}, () => call('concurrent-1', base)));
  assert.equal(counts().effects - before.effects, 1);
  assert(concurrent.some(item => item.status === 'CONFIRMED'));
  assert(concurrent.every(item => ['CONFIRMED','IN_FLIGHT','STATE_UNAVAILABLE','UNKNOWN'].includes(item.status)));
  const final = await call('concurrent-1', base);
  assert.equal(final.status, 'CONFIRMED');
  for (const item of concurrent.filter(item => item.status !== 'CONFIRMED')) assert.deepEqual(await call('concurrent-1', base), final);
  evidence.concurrent = {before, after: counts(), results: concurrent, replay: final};
  // Negative control deliberately bypasses protection twice: journal must catch it.
  const negativeBefore = counts();
  for (let index=0; index<2; index++) {
    const response = await fetch(providerUrl + '/booking', {method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({operationId: 'raw-duplicate', args: base})}); assert.equal(response.status, 200);
  }
  assert.equal(counts().effects - negativeBefore.effects, 2);
  evidence.negative = {before: negativeBefore, after: counts(), expected_duplicates: 2};
  evidence.provider_effects = db.prepare('SELECT * FROM effects ORDER BY id').all().map(row => ({...row,args: JSON.parse(row.args),receipt: JSON.parse(row.receipt)}));
  evidence.reservations = db.prepare('SELECT * FROM reservations ORDER BY id').all().map(row => ({...row,args: JSON.parse(row.args)}));
  evidence.status = 'PASS'; mkdirSync(dirname(output), {recursive:true}); writeFileSync(output, JSON.stringify(evidence,null,2));
  console.log(`PASS ${evidence.probes.length} probes; 12 concurrent workers; ${counts().effects} effects including 2 raw-control duplicates`);
} finally {
  await new Promise(resolve => server.close(resolve)); db.close(); rmSync(root,{recursive:true,force:true});
}

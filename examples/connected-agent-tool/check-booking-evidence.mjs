import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
for (const filename of process.argv.slice(2)) {
  const evidence = JSON.parse(readFileSync(filename,'utf8'));
  assert.equal(evidence.status,'PASS'); assert.equal(evidence.schema_version,1);
  assert.equal(evidence.sdkVersion,'0.1.25');
  assert(Object.values(evidence.hashes).every(value=>/^[a-f0-9]{64}$/.test(value)));
  assert(evidence.probes.length >= 57);
  for (const probe of evidence.probes) {
    const mutation = probe.after.effects - probe.before.effects;
    assert(mutation === 0 || mutation === 1);
    if (probe.response.status !== 'CONFIRMED' && mutation === 0) assert.equal(probe.after.attempts,probe.before.attempts);
  }
  for (const action of ['create','modify','cancel']) {
    for (const prefix of ['lost-ack','restart-unknown','delayed-truth','non-authoritative-absence','mismatched-truth','nonunique-truth']) {
      assert.equal(evidence.probes.find(probe=>probe.name===prefix+'-'+action).response.status,'UNKNOWN');
    }
    assert.equal(evidence.probes.find(probe=>probe.name==='exact-reconciliation-'+action).response.status,'CONFIRMED');
    assert.equal(evidence.provider_effects.filter(row=>row.operation==='lost-'+action).length,1);
  }
  assert.equal(evidence.concurrent.results.length,12);
  assert.equal(evidence.concurrent.after.effects-evidence.concurrent.before.effects,1);
  assert.equal(evidence.provider_effects.filter(row=>row.operation==='concurrent-1').length,1);
  assert.equal(evidence.provider_effects.filter(row=>row.operation==='raw-duplicate').length,2);
  assert.equal(evidence.negative.after.effects-evidence.negative.before.effects,2);
  assert.equal(evidence.provider_effects.length,13);
  assert.equal(evidence.provider_effects.filter(row=>row.args.action==='modify').length,2);
  assert.equal(evidence.provider_effects.filter(row=>row.args.action==='cancel').length,2);
  assert.equal(evidence.probes.filter(probe=>probe.name==='unsupported-effect').length,6);
  assert(evidence.probes.filter(probe=>probe.name==='unsupported-effect').every(probe=>probe.response.status==='INVALID_BOOKING_EFFECT'));
  assert.equal(evidence.reservations.filter(row=>row.status==='CANCELLED').length,2);
  console.log(filename+': booking evidence PASS');
}

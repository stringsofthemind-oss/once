// Controlled booking mock only. Host owns identity, provider URL and durable path.
import { readFileSync, existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
const request = JSON.parse(readFileSync(0, 'utf8'));
const { wrapTool } = await import(request.sdkUrl);
try {
  const fields = ['action','tenant','resource','startsAt','endsAt','timezone','participants',
    'partySize','priceMinor','currency','termsVersion','validUntil','reservationId','expectedVersion'];
  const effect = request.args;
  const invalid = () => {throw Object.assign(Error('Controlled booking fixture requires its complete reviewed effect schema'), {code:'INVALID_BOOKING_EFFECT'});};
  if (!effect || typeof effect !== 'object' || Array.isArray(effect) ||
    !isDeepStrictEqual(Object.keys(effect).sort(), fields.sort()) ||
    !['create','modify','cancel'].includes(effect.action) ||
    ['tenant','resource','timezone','currency','termsVersion'].some(key => typeof effect[key] !== 'string' || !effect[key].trim()) ||
    !Number.isSafeInteger(effect.priceMinor) || effect.priceMinor < 0 ||
    !Number.isSafeInteger(effect.validUntil) || effect.validUntil < 0 ||
    !Array.isArray(effect.participants) || !Number.isSafeInteger(effect.partySize) || effect.partySize < 1 ||
    effect.participants.length !== effect.partySize ||
    effect.participants.some(person => !person || !isDeepStrictEqual(Object.keys(person).sort(), ['customerId','name']) ||
      typeof person.customerId !== 'string' || !person.customerId || typeof person.name !== 'string' || !person.name) ||
    ![effect.startsAt,effect.endsAt].every(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) ||
    !Number.isFinite(Date.parse(effect.startsAt)) || !Number.isFinite(Date.parse(effect.endsAt)) ||
    Date.parse(effect.endsAt) <= Date.parse(effect.startsAt)) invalid();
  try {new Intl.DateTimeFormat('en', {timeZone: effect.timezone});} catch {invalid();}
  if (effect.action === 'create' ? effect.reservationId !== null || effect.expectedVersion !== null :
    !Number.isSafeInteger(effect.reservationId) || effect.reservationId < 1 ||
    !Number.isSafeInteger(effect.expectedVersion) || effect.expectedVersion < 1) invalid();
  if (request.expectedState && !existsSync(request.statePath)) {
    throw Object.assign(Error('Expected booking authority missing'), {code: 'STATE_UNAVAILABLE'});
  }
  const booking = wrapTool(async effectArgs => {
    const response = await fetch(request.providerUrl + '/booking', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({operationId: request.intent, args: effectArgs}),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error('Booking provider response unavailable');
    const receipt = await response.json();
    if (request.lostAck) throw Error('Fixture acknowledgement lost after response parsing');
    return receipt;
  }, {
    operationId: input => input.intent,
    effect: input => ({tool: 'fixture.booking.lifecycle', args: input.args}),
    statePath: request.statePath, leaseMs: 30000,
    reconcile: request.reconcile ? async ({operationId, effect}) => {
      const response = await fetch(request.providerUrl + '/lookup/' + encodeURIComponent(operationId),
        {signal: AbortSignal.timeout(5000)});
      if (!response.ok) return {status: 'UNKNOWN'};
      const observation = await response.json();
      if (observation.status === 'NOT_FOUND') return {status: 'NOT_FOUND'};
      if (observation.status !== 'FOUND' || observation.rows.length !== 1) return {status: 'UNKNOWN'};
      const row = observation.rows[0];
      // Exact complete effect and authoritative historical operation receipt;
      // current reservation state alone cannot prove an earlier modification.
      if (!isDeepStrictEqual(row.args, effect.args) || !isDeepStrictEqual(row.receipt?.args, effect.args) ||
        row.receipt.status !== (effect.args.action === 'cancel' ? 'CANCELLED' : 'ACTIVE') ||
        !Number.isSafeInteger(row.receipt.reservationId) || row.receipt.reservationId < 1 ||
        row.receipt.version !== (effect.args.action === 'create' ? 1 : effect.args.expectedVersion + 1) ||
        (effect.args.action !== 'create' && row.receipt.reservationId !== effect.args.reservationId)) return {status: 'UNKNOWN'};
      return {status: 'CONFIRMED', result: row.receipt};
    } : undefined,
  });
  console.log(JSON.stringify({status: 'CONFIRMED', result: await booking({intent: request.intent, args: request.args})}));
} catch (error) {
  console.log(JSON.stringify({status: error.code || 'ERROR', message: error.message}));
}

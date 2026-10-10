# Controlled booking lifecycle reference

This extends the existing fake booking `verify.mjs` example with creation,
modification and cancellation, using published `wrapTool` from SDK 0.1.25.
It contacts only a disposable loopback provider, never a real reservation system.
Its provider commits reservations and a separate operation-effect journal in one
SQLite transaction. Every accepted mutation adds a journal row; there is no
provider-native operation deduplication. Refused expired inventory or stale
reservation versions are recorded as attempts but cause no mutation.

The host owns one stable intent for each desired lifecycle action. The complete
effect includes action, tenant, resource, UTC start/end instants, named timezone,
participants, party size, price/currency, terms version, quote expiry,
reservation ID and expected reservation version. Transport attempts are not
identity. Reusing an identity with changed effects conflicts. Intentional new
actions use new identities even when their effects are identical. Modification
and cancellation need their own identities and optimistic reservation versions.
All routes in the protected tests enter the reviewed boundary. A direct provider
route is used only by a labelled negative control proving duplicates are detected.

Run with Node 24.19.0 (same-machine SQLite requires Node 24.15+):

```sh
npm install --prefix booking-consumer --ignore-scripts --no-audit --no-fund @once-agent/sdk@0.1.25
node examples/connected-agent-tool/booking-lifecycle.mjs file:///ABSOLUTE/PATH/booking-consumer/node_modules/@once-agent/sdk/dist/index.js evidence/booking.json
node examples/connected-agent-tool/check-booking-evidence.mjs evidence/booking.json
```

On Windows use `file:///C:/...`. Supply the absolute SDK file URL; no package
installation happens implicitly inside the lab. `--local` can replace that URL
for a built source checkout, but the CI workflow tests clean published consumers
on Windows and Ubuntu. Its artifacts contain independently queried provider
journal rows, reservation state, worker statuses and before/after counts.

The lab asserts receipt replay across fresh Node processes, every declared
effect drift, missing identity/expected state, schema refusal, expired quote
and stale-version refusals, three lost-acknowledgement lifecycle operations,
durable UNKNOWN blocking, delayed truth and NOT_FOUND blocking, mismatched and
non-unique lookup rejection, exact authoritative reconciliation, twelve
concurrent duplicate attempts and two raw duplicate mutations as a negative
control. Lost acknowledgement is a deliberate throw after parsing the accepted
response, not a network fault. Positive reconciliation reads the provider's
historical operation journal and matches the complete effect and receipt;
current reservation state alone cannot prove an earlier modify/cancel action.
The delayed/NOT_FOUND/mismatched/non-unique observations are explicit fixture
fault injection. Neither a missing lookup row nor UNKNOWN permits redispatch.

The expected final journal has thirteen mutation rows: eleven protected effects
including one concurrent operation, and two deliberately unprotected duplicates.
Rejected inventory/version actions add no mutation rows. The receipt can be a
confirmed business rejection; confirmed execution does not imply a booking exists.

This is a working reference contract, **not a production booking adapter**.
The mock has no real authentication, inventory service, occupancy/capacity policy,
money, cancellation penalties, timezone/DST scheduling policy or customer data.
Expiry is the fixture quote deadline checked against the provider clock. A real
provider must supply an authoritative operation/receipt lookup, complete account
and effect binding, and validated inventory/version semantics; otherwise refuse
the integration rather than inventing confirmation or retry permission. Native
provider idempotency or constraints should be used when sufficient. No claim of
universal exactly-once, distributed authority, adoption or real-provider readiness.

Only the protection worker restarts; the provider process stays running with
durable journal storage. The lab does not qualify whole application/provider
restart, OS power loss, cancellation races, opaque provider retries, filesystem
attacks or distributed storage. Cold SQLite opening may fail closed with
STATE_UNAVAILABLE; subsequent retries must retain the same authority and intent.

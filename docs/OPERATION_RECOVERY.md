# Local operation recovery

This guide describes the TypeScript source candidate. It requires Node 24.15+
and a persistent SQLite file on the same machine as the callers. Default MCP
installation and existing SDK paths keep their existing contracts. New managed
ledgers use explicit provision, approval, execution and lookup operations.

## Inspect an operation

```sh
once status 'once-intent:...' --state=/var/lib/once/operations.sqlite
once status --unresolved --state=/var/lib/once/operations.sqlite --limit=25 --json
```

The CLI uses a read-only connection, keeps receipts and arguments out of its
output, and never imports application code or contacts the provider. Use
`--after=<last-operation-id>` to page the unresolved queue in operation-ID
order. Each invocation reads a single snapshot. Use `--state=` to select the
correct ledger. Without it, the command uses `.once/operations.sqlite` relative
to the working directory. Limit filesystem access to authorised operators.
Labels and team aliases should contain no credentials, customer data or other
sensitive text. Operation identifiers and fingerprints can also be sensitive.

| State | Meaning and action |
|---|---|
| `NOT_RECORDED` | This ledger snapshot contains no matching record. Check the original identity and ledger continuity. |
| `APPROVED` | The host approval is visible in this snapshot. Check continuity before starting the first dispatch. |
| `IN_FLIGHT` | A claim has an active lease. Keep the original identity and wait. |
| `UNKNOWN` | An outcome remains uncertain or a claim expired. Use the authorised read-only provider lookup. Keep redispatch blocked. |
| `CONFIRMED` | The original receipt can be replayed by its authorisation boundary. Its business meaning is the provider adapter's responsibility. |

Managed ledgers add approval and claim times, last state change, receipt
source and the last provider lookup result and time. Older TypeScript ledgers return available information without adding
schema or backfilling history. An expired claim is shown as UNKNOWN by the reader
without transitioning the ledger. A stored claim can precede every network
request. Legacy operations can opt into `ledgerMode: "existing"` to refuse
initialization; the compatibility default still permits fresh state.

## Protect a host-approved operation

Provision **once**, at installation time, for a new authority. The SDK refuses
to reuse or overwrite an existing filename. If the saved ledger disappears or
is corrupt, stop intake and restore the original consistent authority.

```ts
import {
  approveLocalToolIntent,
  executeApprovedLocalTool,
  provisionLocalLedger,
  reconcileApprovedLocalTool,
} from "@once-agent/sdk";

// Installation only. Deployments that use an independent witness must configure
// its ID here and supply the same witness to every dispatching worker.
await provisionLocalLedger(statePath, witness ? { witnessId: witness.id } : undefined);

// This handler belongs to the authenticated host. Its approval table is the
// source of identity and approved arguments. Keep it outside the model schema.
const intent = {
  tenant: approvedBooking.tenant,
  providerAccount: approvedBooking.account,
  intentId: approvedBooking.approvalId,
};
const effect = {
  tool: "booking.amend",
  args: {
    reservationId: approvedBooking.reservationId,
    expectedVersion: approvedBooking.expectedVersion,
    startsAt: approvedBooking.startsAt,
    endsAt: approvedBooking.endsAt,
  },
};
const operationId = await approveLocalToolIntent({
  statePath, intent, effect, label: "Amend booking", assignedTo: "booking-ops",
});

// Request account-scoped credentials in host code. Pass the stable operation ID
// as a provider idempotency key when supported, plus the resource precondition.
const receipt = await executeApprovedLocalTool({
  statePath, intent, effect, witness,
  execute: ({ args }, context) =>
    approvedBookingClient.amend(args, { operationId: context.operationId }),
});

// A separate operator/job entry point. Its callback can only read provider truth.
const recovered = await reconcileApprovedLocalTool({
  statePath, intent, effect,
  reconcile: ({ operationId, effect }) =>
    approvedBookingClient.lookupExactHistoricalResult(operationId, effect.args),
});
```

The lookup must verify account, operation reference and the complete effect
against documented provider evidence. If evidence is pending, incomplete,
unavailable, contradictory, or a search yields zero rows, return UNKNOWN or
NOT_FOUND. Both keep redispatch blocked. Confirmation requires a replay-safe
receipt. Legacy `protectToolCall` records can use `reconcileToolCall` with the
exact original effect. Never make approval or reconciliation callbacks directly
available as model tools. A retry reuses the approval ID. A changed effect or
genuinely separate operation needs its own trusted approval. A provider-enforced
conditional write protects a resource version across separate valid intents.

## Independent PostgreSQL admission witness

Apply [admission-witness.sql](../sdk/typescript/sql/admission-witness.sql) as a
database administrator to a separate writable primary and insert one explicit
authority ID into `once_admission.authorities`. Use an immutable namespace per
environment and enforce its access boundary with database credentials.
Give the runtime role schema USAGE, SELECT on the provisioned authority, and
the INSERT and required RETURNING SELECT privileges on reservations. Keep
UPDATE, DELETE, TRUNCATE and schema changes behind a separate role. Set and
verify durable commit and replication/failover settings before protecting writes.

Use `createPostgresAdmissionWitness(pool, authorityId)` with an autocommit
pool against the writable primary, and configure a bounded connection and query
timeout. Every writer for the same logical operations must use the same
authority and trusted identity policy. Keep provider-native keys and
preconditions in effect. Verify that your ingress has no alternative raw write
route. Store this witness independently of the local ledger backup and restore
domain. Preserve reservations for as long as an earlier effect may matter.

The witness gives a write-once dispatch admission across workers sharing it,
including workers with separate SQLite files. A usable provider receipt still
belongs to the local ledger or to authoritative reconciliation. An original
SQLite claim, a durable independent reservation, or a timed-out acknowledgement
from either can precede the provider dispatch, so a protected action can end
with zero effects and require review. The witness may block during outages.
Replacing or rolling back the witness itself can reintroduce the risk. This
profile is opt-in and does not claim full history attestation, cross-host receipt
replay, or production failover qualification.

## Candidate validation

- Run `node --test sdk/typescript/test/operation-recovery.test.mjs` after building
  the SDK. The tests cover the operation queue, legacy compatibility, approval
  binding, lost acknowledgements, missing or restored local state and witness
  timeouts.
- Run the PostgreSQL integration test against a disposable empty database using
  `ONCE_TEST_POSTGRES_URL`. The test exercises two worker processes, two local
  histories and a separately counted provider journal, then restores a valid
  pre-dispatch snapshot. SDK CI configures a disposable PostgreSQL service.
- Use the [published refund fixture](../examples/first10/README.md) and
  [controlled booking lifecycle](../examples/connected-agent-tool/BOOKING_LIFECYCLE.md)
  as provider baselines. The booking fixture checks stale amendments, exact
  historical positive reconciliation and non-authoritative absence. A provider
  becomes suitable for real traffic only after its own sandbox contract and
  credentials have been checked.

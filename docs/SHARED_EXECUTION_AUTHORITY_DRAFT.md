# Shared execution authority — unreleased draft

PR #303 adds an opt-in PostgreSQL storage adapter beneath the existing SDK
`protectLocal` kernel. `protectToolCall` and `wrapTool` accept the same explicit
`authority` option. There is no second execution state machine, provider adapter,
universal connector proxy, or automatic routing change. Existing local callers
retain SQLite and their existing identity/effect format.

## Admission and deployment boundary

The host supplies an already configured SQL pool, fixed authority namespace,
expected generation/epoch, and independent continuity witness. These are trusted
configuration, never tool/model arguments. Pool credentials stay with the host;
Once persists only namespace, logical identity, effect fingerprint, reservation
owner, lease, execution state and JSON receipt. Driver/witness failures are
sanitized rather than attaching errors that might contain credentials.

Use one authority namespace for all workers protecting the same logical domain.
Keep tenant/provider account and every effect-bearing input in the existing
effect binding. Do not change namespace, operation ID, generation or epoch to
escape uncertainty. A genuinely different intent gets a different logical ID.
Authorization of actors and validation of complete provider account/effect fields
remain host responsibilities; this storage adapter does not infer them.

Operator provisioning is explicit, using
[`execution-authority-v1.sql`](../sdk/typescript/sql/execution-authority-v1.sql).
It creates tables but no authority. Insert the initial authority row and seed its
independent witness out of band only for a genuinely new authority, before
admitting workers. The runtime performs no DDL, provisioning, repair or fallback.
Missing metadata, missing tables, unsupported version, wrong generation or epoch
block access. Do not run provisioning against a missing expected authority.

The SQL pool must connect to one authoritative writable PostgreSQL primary, with
durable commits and an operator-qualified HA/restore policy. Use a dedicated
runtime role with only the required SELECT/INSERT/UPDATE access; no DELETE, DDL,
provisioning or administrative capabilities. The pool must enforce connection
deadlines and TLS/authentication as appropriate. The fixed `once_execution` schema
avoids search-path substitution of unqualified execution tables.

```ts
const authority = createPostgresExecutionAuthority({
  pool: hostOwnedPool,
  authorityId: admittedDomain,
  expectedGeneration: admittedGeneration,
  expectedEpoch: admittedEpoch, // decimal string
  witness: independentContinuityWitness,
});

const send = wrapTool(hostOwnedSend, {
  operationId: input => input.sendIntentId,
  effect: input => ({ tool: 'reviewed-account.send', args: input }),
  authority,
  reconcile: authoritativeProviderLookup,
});
```

This is an integration outline: the host must provide the pool, witness,
authority bindings, callable and provider lookup. There is deliberately no
production witness bundled in this draft. `statePath` and `authority` cannot be
combined. There is no fallback when the shared authority fails.

## Reservation and fencing

Short PostgreSQL transactions lock the authority metadata row, serializing
workers within that namespace. The operations primary key and insert-if-absent
under that lock yield one reservation owner. Workers use database time for
leases, not their own clocks. A random owner token identifies the one claim;
generation/epoch admission fences authority changes. Before dispatch, the store
checks fingerprint, state, owner and lease again. Confirmation also compares
the exact live owner and lease. A stale owner cannot confirm a result.

Expiry never transfers permission to a replacement worker: it changes CLAIMED
to UNKNOWN. A crash before provider dispatch can therefore leave zero effects
and still block indefinitely. UNKNOWN and non-definitive absence do not authorize
redispatch. Only the existing kernel's positive provider reconciliation path can
confirm ambiguity. Concurrent reconciliation returns the durable winner's
receipt. Changed effects conflict before replay or reconciliation.

This is cooperative execution fencing, not provider-enforced revocation. A
worker can pause after its final check, and an already issued provider request
cannot be recalled by changing the database epoch. No other worker is granted a
replacement dispatch, even after expiry. Do not claim stale-worker revocation at
the provider or universal exactly-once. Preserve native provider idempotency
where available. Opaque internal callback retries remain outside this boundary.

## Continuity protocol and deliberate availability cost

Every store transaction, including replay admission, compares and advances a
checkpoint `(authorityId, generation, epoch, revision)` in an **independent,
linearizable, durable witness** before committing the new SQL revision. The
witness must atomically accept exactly the expected checkpoint and persist the
next checkpoint before returning true. Missing state and mismatches return
false; transport ambiguity throws. No implicit seed or retry is permitted.

The external witness must have a separate restore/failure domain from the SQL
authority, authenticated access, bounded request deadlines, and its own durable
operator-controlled provisioning. A callback returning true, in-memory counter,
cached read, local signature, or witness restored alongside the SQL database
does not satisfy that contract. The test witness is only a fixture.

Ordering is intentionally witness-first:

1. Lock and admit SQL metadata; perform the tentative row operation.
2. Atomically compare-and-advance the external witness.
3. Update SQL revision and commit with `synchronous_commit=on`.
4. Return to the execution kernel only after commit acknowledgement.

If step 2 is ambiguous, or step 3 fails/loses acknowledgement before a known
commit, the witness may be ahead. Do not rewind the witness or automatically
retry its CAS. Subsequent calls fail closed until an operator investigates.
A committed SQL transaction with a lost acknowledgement can be admitted again
when both stores agree; an uncertain reservation still cannot redispatch.
This protocol chooses safety over availability; it is not an atomic distributed
transaction and is not an HA recovery implementation.

A coherent older SQL backup is rejected when its checkpoint is behind the
independent witness. Selective row deletion/tampering while retaining current
metadata, malicious SQL administrators, a lying witness, and rollback of both
authorities are outside this proof. An epoch or generation UUID alone is not
proof of latest history. Recovery must preserve all possibly dispatched
identities and establish authoritative provider truth where ambiguity remains;
never reset state merely to resume service.

The initial adapter serializes a whole namespace and advances the witness even
for reads. Throughput, production witness qualification, HA, disaster recovery,
retention, actual multiple-host operation and independent security review remain
release gates. No production readiness or provider certification is claimed.

## Errors and conservative host decisions

| Error | Host decision | Required handling |
| --- | --- | --- |
| CONFLICT | CONFLICT | Preserve identity; investigate changed effect |
| UNKNOWN / IN_FLIGHT / EXECUTION_RIGHT_LOST | RECONCILE_REQUIRED | Never dispatch around the boundary |
| STALE_AUTHORITY | DENY_STATE | Re-admit only after operator review of authority |
| AUTHORITY_MISSING / STATE_UNAVAILABLE | DENY_STATE | Restore expected state; never recreate |
| CONTINUITY_LOST / CONTINUITY_UNAVAILABLE | DENY_STATE | Investigate both authorities; no automatic recovery |

These are documented mappings, not a new runtime decision engine. A callback
that already ran and cannot durably confirm returns UNKNOWN, preserving the
allowlisted sanitized authority code as its cause. No returned error authorizes retrying
the provider directly.

## Reproducible evidence

`npm run test:shared-authority` requires `ONCE_TEST_POSTGRES` pointing to a
disposable PostgreSQL administrator database. It creates and drops a randomly
named test database; it fails rather than silently skipping when absent. CI uses
a PostgreSQL service. No production credentials or real provider account are
used.

The integration tests use independent Node worker processes over TCP to real
PostgreSQL, a separate durable SQLite witness behind HTTP, and a separately
flushed fixture-provider journal. Assertions count provider effects independently
of SDK returns. Tests cover concurrent reservation, crash before/after dispatch,
restart, changed effect/account, lost acknowledgement, stale owner/epoch,
concurrent reconciliation, missing authority/table, unsupported schema, old
history, witness outage/missing state/ack loss, and SQL commit failure/ack loss.

This is local multi-process PostgreSQL evidence, not separate-host, production
HA or real-provider evidence. See the roadmap for remaining acceptance lanes.

Transaction design reference: PostgreSQL's
[Read Committed and row-lock semantics](https://www.postgresql.org/docs/18/transaction-iso.html).

## Bundled continuity witness and deadlines

`createPostgresContinuityWitness({pool, expectedWitnessId})` supplies a durable
linearizable compare-and-advance using a separately provisioned PostgreSQL
checkpoint. Provision `sql/continuity-witness-v1.sql` and its metadata/checkpoint
explicitly. It never inserts missing checkpoints, accepts rewinds or changes
identity. It acknowledges only after synchronous commit, requires fsync and
full-page writes, and sanitizes driver failures.

The host owns authenticated pools, verified TLS, connection deadlines, database
permissions and placement in independent failure/restore domains. Supplying the
same pool object is rejected; distinct objects pointing to the same database
cannot establish separation. The local two-database fixture is not proof of
independent infrastructure or production qualification.

Execution authority defaults to a 5000ms witness acknowledgement deadline,
configurable from 1 through 60000ms. Timeout means uncertainty: no CAS retry,
no execution. A late witness commit can leave continuity ahead and therefore
require operator recovery. The deadline does not cancel the host pool request;
the pool must bound connections and requests. Dispatch admission checks database
time again after witness acknowledgement and checks elapsed monotonic time after
SQL commit. Expiry while waiting denies dispatch.

Provider callback and reconciliation exceptions carry no raw cause. Confirmation
failures preserve only a sanitized allowlisted authority error code, never a
driver/provider exception. This reduces accidental credential leakage through
error inspection; it is not arbitrary-data redaction.

## Recovery exercise and operator procedure

1. Stop admissions and fence or terminate all original workers. Drain or cancel
   outstanding witness requests and confirm stable checkpoints before comparing
   or restoring history. A timeout does not cancel CAS. Preserve both
   databases, provider journal, expected identities and generation/epoch pins.
2. Read both checkpoints through authenticated operator connections. Do not
   rewind continuity or replace missing expected authority. Record the mismatch
   and retain immutable copies before repair.
3. Restore the complete original execution history from trusted backups/logs
   that match the independent checkpoint. Validate every possibly dispatched
   identity and its effect fingerprint. A revision number alone proves nothing
   about completeness. Keep uncertain operations UNKNOWN; provider absence does
   not authorize redispatch.
4. If a complete matching history cannot be established, remain blocked. A
   witness-ahead aborted transaction has no generic automatic repair here. Do
   not invent rows, advance metadata alone, discard uncertainty or clear a claim
   just to make the service available.
5. Compare checkpoints and retained rows, then reconcile uncertain outcomes only
   through authoritative provider truth. Admit fresh workers with the same pins;
   verify old receipts replay and changed effects conflict before resuming.

The disposable container proof retains a complete matching execution snapshot,
deliberately restores an older coherent history, observes CONTINUITY_LOST, then
restores that complete snapshot without changing the witness. A previously
ambiguous provider write stays represented and replays its reconciled receipt.
This qualifies that recoverable snapshot case only; missing suffix recovery and
production disaster recovery remain operator-blocking gates.

## Isolated container-host scope

`node scripts/container-host-authority-proof.mjs` requires Linux Docker and runs
only disposable fixture containers. Two application hosts have separate network
namespaces, alongside separate execution SQL, continuity SQL and provider journal
containers on one CI runner. It tests reservation contention, killed application
process, authoritative readback, host network partition, witness outage, SQL
restart and coherent rollback/recovery. Provider journal counts are checked
independently. It does not establish independent physical-host, regional or
production failure behavior. No deployment or real-provider operation occurs.

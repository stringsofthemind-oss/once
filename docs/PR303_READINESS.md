# PR #303 enterprise qualification and readiness

Assessment date: 8 October 2026. This is an evidence ledger and operator gate,
not production certification. Baseline inspected: commit
`9c820cae2c42eb38bb690dae8a90e6d44fbdd42e`, branch
`feat/execution-authority-contract-v1`. Qualification fixes made after that
baseline require their own passing CI; baseline checks do not validate later edits.

**Decision: BLOCKED for a final production-readiness decision; keep PR draft.**
Real Stripe qualification, independently placed authority/witness infrastructure,
and operational recovery/performance qualification remain incomplete.

## Classification convention

- **VERIFIED**: current configuration/source/remote state observed directly.
- **TESTED**: reproducible executed assertions, scoped to their actual environment.
- **BLOCKED**: required dependency is absent; identify the minimum owner action.
- **UNVERIFIED**: a claim or operational property has no sufficient observation.
- **NOT AUTHORISED**: merge, release, package publication and production deployment
  are excluded by the mandate. Test infrastructure and bounded sandbox operations
  are authorised, but available access must still establish resource ownership.

## Architecture and trust boundaries

The existing `protectLocal` kernel uses a host-selected PostgreSQL execution
store; `protectToolCall` and `wrapTool` share that kernel. Operator provisioning
creates fixed schemas and seeds a trusted namespace, generation and epoch.
Each transaction locks the namespace's authority row, checks continuity against
an independent witness, advances that witness, and commits execution history.
Claims use database-time leases and unique owners. Before dispatch and
confirmation, ownership and admission are checked again.

The witness is an execution-admission dependency, never a dispatcher. Its
checkpoint must be durable, linearizable and independently restored. Host-owned
database pools, account credentials, authorization and complete effect binding
are trusted configuration. The Stripe profile pins a fixed API origin, sandbox
account, completed test PaymentIntent, amount, currency and operation identity.
The provider's native idempotency key is retained. The host must route every
consequential write through the reviewed boundary; opaque callback retries and
unprotected writes do not inherit its protection.

Supported safety intent: confirmed receipts replay; changed effects conflict;
ambiguous claims become UNKNOWN; expiry never grants a second dispatcher;
positive authoritative reconciliation may confirm uncertainty. Missing authority,
failed continuity and connectivity deny dispatch. This is cooperative fencing:
an issued request cannot be revoked at Stripe by changing an epoch. There is no
universal exactly-once guarantee, automatic distributed repair or certified HA.

Source: [shared-authority contract](SHARED_EXECUTION_AUTHORITY_DRAFT.md),
[`postgres-authority.ts`](../sdk/typescript/src/postgres-authority.ts),
[`postgres-continuity-witness.ts`](../sdk/typescript/src/postgres-continuity-witness.ts).

## Ten required host bindings

All ten were **VERIFIED absent** in Process, User and Machine environment scopes
on the inspected Windows host. Only booleans were emitted; no value was printed.
This establishes absence in those scopes, not absence in every possible vault.
No designated Stripe/PostgreSQL secret-store or infrastructure provisioning
capability was exposed to this task. Unrelated credentials were not searched.

| Setting | Expected type and validation | Owner and dependency |
| --- | --- | --- |
| `STRIPE_SANDBOX_SECRET_KEY` | Secret string, `sk_test_` prefix; authenticated `/account` must match pin, parent payment/charge must be test mode. Prefix alone is insufficient proof. | Payment account owner supplies existing sandbox key through secure host binding. |
| `STRIPE_SANDBOX_ACCOUNT_ID` | Nonsecret `acct_…` string, exact authenticated account match. | Same payment owner; bound to key. |
| `STRIPE_SANDBOX_PAYMENT_INTENT` | `pi_…`; exact ID, succeeded USD test payment and captured, undisputed test charge; remaining refundable balance at least 100 cents at dispatch. | Payment owner designates existing eligible payment. Runner never creates a charge. |
| `ONCE_EXECUTION_DATABASE` | Secret credential-bearing `postgres:`/`postgresql:` URL with host/user/password/database; no query/fragment overrides; verified certificate TLS, 5s connection and 10s query deadlines. | Infrastructure owner; preprovisioned durable authoritative writable PostgreSQL and restricted role. |
| `ONCE_CONTINUITY_DATABASE` | Same URL/TLS/deadline contract, independently authenticated and independently restored cluster. Different URLs/pool objects alone do not establish independence. | Infrastructure/witness owner; separate durable linearizable witness and role. |
| `ONCE_AUTHORITY_ID` | Nonempty string; exact execution metadata/checkpoint namespace match. | Execution authority owner; fixed across all relevant workers/retries. |
| `ONCE_AUTHORITY_GENERATION` | Nonempty string, exact admitted generation match; use operator-managed unique generation. Runtime does not require UUID syntax. | Execution authority owner; provisioned with matching witness checkpoint. |
| `ONCE_AUTHORITY_EPOCH` | Canonical nonnegative decimal string, PostgreSQL bigint range; exact epoch match. | Execution authority owner; stable pin, never changed to evade uncertainty. |
| `ONCE_WITNESS_ID` | Nonempty string, exact witness metadata match, schema version 1. | Witness owner; independently provisioned identity. |
| `ONCE_QUALIFICATION_OPERATION_ID` | Stable explicit logical intent, bounded identifier accepted by runner, unique only for a genuinely new designated qualification. | Qualification owner records identity before starting and retains it on every recovery/rerun. |

Provision schemas using the reviewed
[execution SQL](../sdk/typescript/sql/execution-authority-v1.sql) and
[witness SQL](../sdk/typescript/sql/continuity-witness-v1.sql) only for new
authorities. Seed matching revision-zero metadata/checkpoint out of band. Never
use provisioning scripts to replace missing expected history. Runtime has no
DDL/repair fallback. Require `fsync=on`, `full_page_writes=on`, synchronous commit,
durable storage, bounded authenticated connections and an approved restore policy.
TLS validates the server certificate; private CA trust must be supplied securely
through host runtime configuration, never by disabling verification.

Execution runtime role: schema USAGE, authorities SELECT and UPDATE(revision),
operations SELECT/INSERT and UPDATE(state,result_json,owner,lease_until).
Witness role: schema USAGE, metadata SELECT and UPDATE(schema_version),
checkpoints SELECT and UPDATE(revision). PostgreSQL FOR SHARE requires UPDATE
on at least one metadata column; SELECT alone was **TESTED** to reject with 42501.
The CHECK-constrained schema_version column grants row-lock admission without
permitting witness identity changes or a new supported schema version. Separate
provisioning/operator roles own DDL and seeding. No runtime DELETE, TRUNCATE,
CREATE, ownership or administrative capability. These privileges are requirements,
**TESTED** against restricted local fixture roles; **UNVERIFIED** on any external
deployment. CI fixture administrator credentials alone do not establish
least-privilege deployment.

## Infrastructure evidence and qualification gaps

**VERIFIED**: Docker, `psql` and `postgres` were not on PATH; Node and GitHub CLI
were available. Windows service inventory could not be read under current
permissions, so installed-service absence is **UNVERIFIED**. Further designated
workspace inspection located existing PostgreSQL 18.4 binaries outside PATH.
A new disposable cluster was initialized under this task's work/pg-test/isolated-data
and started hidden with redirected logs, bound only to 127.0.0.1:55483. No previous
cluster was modified. Trust authentication and plaintext loopback are fixture-only;
they are not deployment credential/TLS evidence. Initial sandbox initialization
stalled and was cancelled; permitted unsandboxed initialization succeeded. The
first test attempt hit sandbox EACCES for local TCP; its failed log was retained,
then the authorised loopback rerun passed. No external database was provisioned.
Local database availability does not close the independent failure-domain gate.

**TESTED local update:** the strengthened shared suite initially passed 31/31
with zero failures/skips. After the independent provider receipt-drift fix,
the targeted Stripe fixture passed 5/5. The new restricted-role witness test
passed 7/7, including SELECT-only row-lock rejection, safe execution/replay/conflict
with one fixture callback effect, and runtime DDL/DELETE/TRUNCATE/provision/identity
mutation denials. Both roles have NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/
NOBYPASSRLS and explicitly scoped database CONNECT. These are local fixture
results, not external PostgreSQL or real Stripe results. The final combined
PostgreSQL/witness/Stripe-profile/TLS test invocation after all qualification,
receipt-drift, malformed pagination and privilege edits passed **33/33**, zero
failures/skips. The retained independent fixture-provider journal was re-counted:
**8 effects, 8 identities, maximum 1 effect each**. Execution rows and witness
checkpoints were retained before disposable test database removal; their snapshot
includes deliberate fault injection and is not a production recovery image.
The evidence package has file SHA-256 values in its manifest. Only the newly
created loopback cluster was stopped after final tests; previous clusters were
untouched. Reproduce from the SDK directory with ONCE_TEST_POSTGRES bound to a
disposable administrator database and ONCE_TEST_EVIDENCE_DIR to an output directory:
`node --test test/postgres-authority.test.mjs test/postgres-continuity-witness.test.mjs test/stripe-sandbox-profile.test.mjs test/stripe-verified-tls.test.mjs`
after building once. This command must not silently skip without PostgreSQL.

**TESTED**, baseline GitHub Actions
[run 37746989991](https://github.com/stringsofthemind-oss/once/actions/runs/37746989991):
27 shared-authority tests passed, 61 kernel/tool integration tests passed, zero
failures. The container proof logged all five scenario groups PASS and separately
asserted a retained fixture-provider journal containing two effects for two
identities, maximum one effect each. The designated CI artifact was downloaded;
an independent parser re-counted its two rows/two identities/maximum one each and
asserted five PASS groups. Artifact SHA-256 values:
`host-proof.json`: `7c482e8b1741327028e45611d925e39ea2b437f07702515b20ef6ffe983631f6`;
`provider-journal.jsonl`: `f4deb2017ece7d68350bbf3a73501453c01f9b726e6d098b24c38c65541212eb`.
These are real PostgreSQL/container fault
assertions with a simulated provider. Application containers and separate SQL
containers share one runner/physical failure domain; they are not independent
physical hosts, regions, real Stripe or production infrastructure.

| Acceptance lane | Current classification and evidence | Remaining gate |
| --- | --- | --- |
| Concurrent workers/reservation/replay/conflict | TESTED, container hosts and independent fixture journal | Repeat on separate owned hosts with real network boundaries. |
| Worker termination and restart reconciliation | TESTED, crashed container worker, retained provider journal; fixture manually expires its lease | Natural expiry and real provider restart exercise remain UNVERIFIED. |
| Host network partition | TESTED, Docker network disconnect denies STATE_UNAVAILABLE | Independent-host asymmetric partitions remain BLOCKED on resources. |
| Witness outage/SQL restart | TESTED, fixture continuity stop and execution restart, then replay | Real storage durability, HA and failure domains remain UNVERIFIED. |
| Coherent old-history rollback | TESTED, continuity rejects old execution checkpoint | Joint rollback, administrator compromise and selective deletion with current metadata are outside proof. |
| Recovery with complete matching snapshot | TESTED, restore retained complete history without witness rewind | Missing suffix/ambiguous commit recovery remains operator-blocking; no generic repair exists. |
| Real Stripe lost acknowledgement/refund count | BLOCKED, ten host bindings absent | Execute repaired bounded runner only after authenticated prerequisites; retain provider listing and exact identity evidence. |
| Verified TLS/restricted runtime roles | TESTED local TLS configuration and restricted-role denials | Real handshake, certificate/expiry and deployed role-denial tests BLOCKED on external clusters. |
| Independent authority/witness backup domains | UNVERIFIED/BLOCKED | Owner supplies placement and restore-policy evidence, then independent restore exercise. |
| Production readiness | BLOCKED | Provider, topology, recovery, permissions and performance gates must be satisfied. |

The complete container source is
[`container-host-authority-proof.mjs`](../sdk/typescript/scripts/container-host-authority-proof.mjs).
Results above were read from successful CI logs, not rerun on this Windows host.

## Threat model and evidence limits

| Threat | Intended boundary / evidence | Residual risk |
| --- | --- | --- |
| Same identity, changed account/payment/amount/canonical JSON | Effect fingerprint conflict; deterministic adversarial/kernel tests | Host omitted effect fields or changed identity bypass semantic intent protection. |
| Expired/stale worker or process crash | Exact owner/lease/epoch checks, no replacement dispatch; local/shared fixtures | Worker may issue after final check; provider cannot revoke an in-flight request. |
| SQL coherent rollback | Independent witness checkpoint denies stale history | Witness and SQL jointly restored, lying witness, or tampered rows with unchanged metadata outside proof. |
| Witness timeout/commit ambiguity | Fail closed; no CAS retry or rewind | Late witness commit can strand service; complete history may be unavailable. |
| SQL commit lost acknowledgement | Preserve uncertainty; matching checkpoints can be admitted | Incomplete history cannot be repaired from revision alone. |
| Secret leakage | Sanitized driver/provider exceptions; fixed host pools | Arbitrary host logs, receipt contents and provider metadata require host redaction policy. |
| Native idempotency expiry/provider drift | Durable local UNKNOWN and positive readback only | Provider-native key does not prove Once attribution or complete effect binding. |
| Malicious operator/SQL administrator | Outside trusted operator boundary | SELECT/UPDATE role restrictions reduce exposure, not cryptographic tamper proof. |

Agent security review is useful independent implementation review, not external
human certification. Canonicalization conclusions must come from Once's own
regressions; a CrewAI finding is a test prompt, not proof of a Once defect.

## Recovery and incident procedure

1. Stop new admissions; terminate/fence original workers; drain outstanding
   witness requests. A timeout does not cancel a late CAS.
2. Preserve immutable execution/witness snapshots, identity/effect bindings,
   sanitized errors and provider evidence. Do not reset epochs, identities,
   checkpoints or CLAIMED/UNKNOWN rows to restore availability.
3. Read both checkpoints using authenticated operator roles. Establish complete
   matching execution history from backups/WAL, including possibly dispatched
   identities. If matching complete history is unavailable, remain blocked.
4. Keep UNKNOWN for missing, pending, duplicate or incomplete provider truth.
   Reconcile only a positively matching authoritative result. Missing receipt or
   absent provider match never authorizes redispatch.
5. Verify continuity agreement, existing confirmed replay, changed-effect
   conflict and old-worker fencing before admitting replacement workers with
   the original bindings. Retain an incident audit and operator approval.

A witness-ahead aborted transaction has no generic repair mechanism here.
Availability and recovery time must be explicitly accepted by the deployment
owner; no RTO/RPO has been measured or certified.

## Observability and performance acceptance

**UNVERIFIED operational requirements**: host-owned telemetry should count
admission denials by sanitized code, UNKNOWN/in-flight age, reconciliation results,
conflicts, witness latency/timeouts, namespace lock wait, pool exhaustion and
database TLS/availability. Record operation correlation using a nonsecret
controlled reference; avoid credential-bearing URLs, raw exceptions, request
headers and unreviewed receipt/effect data. Alert immediately on continuity
loss/missing authority, sustained unavailable state, expired unresolved claims
and inconsistent provider counts. Retain both store evidence independently.

These are deployment requirements, not claims that dashboards/alerts ship in
this PR. Test alert delivery and incident ownership before production admission.

**VERIFIED design trade-off**: every transaction, including replay reads, locks
one namespace authority row and advances the external witness. Throughput is
therefore constrained by serialized authority/witness latency; increasing worker
count does not eliminate that bottleneck. Witness-first commit deliberately
trades availability for continuity safety. Pool/deadline tuning must not weaken
UNKNOWN or continuity behavior. **UNVERIFIED**: production throughput, p95/p99
latency, contention fairness, connection budget, overload recovery, storage growth,
retention safety and HA failover behavior. Require an owned workload benchmark
including hot-namespace contention and witness delays, recording latency/error
distribution and independent provider effects. Do not invent performance numbers.

## Minimum secure owner action and decision matrix

The single best next action is to securely bind an existing designated Stripe
sandbox payment/account and two already provisioned PostgreSQL clusters with
documented independent failure/restore placement to the qualification host.
Do not paste credentials into chat or commit them. Have infrastructure owners
verify matching seeded metadata, certificate trust, durable settings and runtime
role grants; payment owner verifies an eligible completed test payment and accepts
the bounded USD 1 qualification. Record the stable operation identity before
running; recovery always retains it. This unlocks real-provider execution and
independent-host exercises without manufacturing credentials or resources.

| Decision | Classification | Required next evidence |
| --- | --- | --- |
| Preserve draft, continue local code/test qualification | VERIFIED appropriate | Passing CI for final commit and independent review of final changes. |
| Execute authorised Stripe sandbox qualification | BLOCKED | Ten verified bindings and preflight prerequisites. No Stripe operations made in this assessment. |
| Claim independent infrastructure qualification | BLOCKED | Separate owned hosts/clusters, placement evidence and recorded failure/restore exercises. |
| Claim enterprise production readiness | BLOCKED | Provider/topology/access/recovery/observability/performance gates above. |
| Merge/release/publish/production deploy | NOT AUTHORISED | Separate final owner go/no-go after concrete reviewed evidence. |

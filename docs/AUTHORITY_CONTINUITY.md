# Authority continuity: measured local boundary

The TypeScript local path requires retained durable authority. It cannot
distinguish a new installation from total loss of an old database after restart.
A missing row does not establish provider absence.

## Controlled experiment, 2026-10-01

Run `node sdk/typescript/scripts/authority-continuity-regression.mjs` after
building. Set `ONCE_PRIOR_IMPLEMENTATION` to the absolute public 0.1.22
`dist/index.js` to include upgrade/rollback evidence. The harness owns fresh
temporary directories and deletes only those fixtures. Provider effects live
in a separate file ledger: **simulated, not external provider evidence**.
Each invocation is a fresh process.

| Scenario | Expected contract | Observed on Windows, Node 24.19 | Effects |
|---|---|---|---|
| Normal restart | Replay retained receipt | Original receipt | 1 |
| SQLite current snapshot restore | Replay retained receipt | Original receipt | 1 |
| Public 0.1.22 to review candidate | Retained schema/effect stays replayable | Original receipt | 1 |
| Candidate rollback to 0.1.22, retained state | Same unchanged authority | Original receipt | 1 |
| Closed-process complete state loss | No cross-restart loss detection promised | New database, redispatch | **2** |
| Pre-effect snapshot restored after commit | Stale authority cannot remember missing effect | Redispatch | **2** |
| Process death after provider commit | Reconcile abandoned claim after lease | Original receipt, no write | 1 |
| Recovery interrupted | Read-only recovery can resume | UNKNOWN while unavailable, then receipt | 1 |
| Provider truth unavailable | Block | UNKNOWN | 1 |
| ABSENT assertion after known commit | No local redispatch | UNKNOWN | 1 |

These are demonstrated limitations of the retained-authority contract, not a
new bug introduced by the optimization. They disprove a broader claim that
local restart protection survives arbitrary state loss or stale restore.
Live-session file checks do not close the cross-restart gap. This harness does
not certify multi-host coordination, arbitrary-version migrations, positive
contradictory receipts or an untrusted reconcile callback.

## Operational gate

Stop provider writes after suspected authority loss or stale restore. Retain
business intents independently, identify the affected interval and verify
provider truth before resuming. Do not point the wrapper at an empty file to
escape STATE_UNAVAILABLE or UNKNOWN. Current backup used SQLite `VACUUM INTO`
after calls completed; this is not a hot-backup load test.

A cross-restart authority-loss guarantee requires an independently retained
admission/authority contract and a reviewed migration/bootstrap flow. A sentinel
beside the database can disappear with it and cannot prove freshness after
rollback. Adding one without resolving this boundary gives false confidence.
No such kernel change is included in this candidate.

## Forensic confirmation

`npm run test:authority-forensics` records exact inputs, SQLite rows/schema,
fingerprints, receipt envelopes, independent provider contents, child process
IDs and UTC snapshot/restore boundaries. A stale but valid snapshot retains an
older confirmed B while omitting later committed A; retry A produces its second
effect. Complete authority-directory loss does likewise. A current snapshot
replays A. In all these cases the supplied reconcile callback is never invoked:
missing rows take first-admission, while confirmed rows replay directly.

The harness also models an atomic provider-native identity/effect deduplication
contract surviving local loss. Once dispatches again, but that simulated
provider returns its existing receipt without another effect. This is a
mechanism illustration, not a real-provider or unlimited-retention guarantee.
The provider store is independent of Once loss, and must remain so for that
stronger boundary. No production execution code or storage schema changes.

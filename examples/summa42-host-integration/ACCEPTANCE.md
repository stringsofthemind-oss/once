# Summa42 #35 acceptance and original-versus-protected evidence

Target: https://github.com/SofiaFlux/summa42/issues/35. Once base source is
8381734a9be368138546121ae708ec9c55be8e89. The original eight-scenario evidence
was preserved in local commit 407be3d33a0cff9f30c436c3fd9133178561b0b4 before
implementation. The reused storage/kernel work is from draft PR #303 head
ae906f64fa6c532d8f2052f4d13d9f13002fa077. Public Summa42 services are pinned at
efc6794ea79a4be5b2f60e376833a1d03cba053c. Exact final commits, package hashes,
test exits, CI and posting/release status are in `validation.json`.

## RED → GREEN

| Protection requirement | Original legacy configuration | Explicit admitted host configuration |
| --- | --- | --- |
| T06: same real intent, fresh planner operation ID | Two committed effects; maximum-one invariant fails RED | H01: IDENTITY_CONFLICT; original intent remains one effect. Invented unadmitted slot is INTENT_REQUIRED. A separately authorized identical intent has its own distinct admitted ID and one effect. |
| T07: schema-valid empty replacement authority | Two committed effects; maximum-one invariant fails RED | H02: CONTINUITY_LOST for empty/partial history with current metadata, locally rehashed replacement, and rewound metadata; no second provider POST. Restoration of the exact original history permits replay, still one effect. H12: worker-local checkpoint replacement has no authority over the independently held execution history. |
| Reservation followed by pre-effect crash | The old proof did not qualify this host gate | H04: actual worker kill; zero effects, persisted UNKNOWN, no guessed confirmation or redispatch. H05: admission alone creates no execution record; a worker killed before claim can later execute once. |

The independent checker deliberately fails on the original baseline. The old
eight-scenario tests are retained; their known two-effect limits do not count as
protection success. New H01/H02 assertions require denial **and** independent
provider-effect counts. Read original raw results alongside the protected run. A separate revision-only partial-restore RED control also records two effects under the same operation ID after operation-row loss while current metadata is retained; this motivated the independently state-bound v2 checkpoint.

## Issue criterion mapping

| #35 criterion | Verified implementation/evidence | Boundary |
| --- | --- | --- |
| Stateful TwinProvider with dropped/delayed acknowledgements | Existing order twin fsyncs a provider-owned journal, never deduplicates and never reads Once state. Original raw control creates two effects. H03 drops socket acknowledgement after commit; retained registered-action tests exercise delayed/held acknowledgement. | Controlled loopback provider, not a commercial provider or network conformance certification. |
| OUTCOME_UNKNOWN never grants retry permission | H03/H04/H08 and actual Go recovery: no second POST, UNKNOWN is durable; ABSENT, lookup failure, incomplete/stale/forged receipt remain non-authorizing. | No liveness guarantee without authoritative positive truth. |
| Reconciliation before replacement Attempt/planner progress | The actual reference host calls Summa42's real Reconciler **before** StartAttempt. Three fresh Go recovery processes retain the original Attempt and unresolved exposure; direct SQLite inspection proves only one Attempt existed while blocked. After exact reconciliation, replacement Attempt creation proceeds. | This is the configured reference task entrypoint. Full Box/LLM/global scheduler wiring and unrelated commitments are not qualified. Deploying that host-wide gate remains an integration responsibility. |
| Non-idempotent commit, ack drop, worker kill, replacement, one unresolved effect | H03 kills an actual MCP worker. The actual service proof kills the Go worker while Summa42's durable operation remains DISPATCHED; both proofs retain exactly one provider effect/POST through repeated fresh processes and reconcile the exact receipt. | Same-machine processes and two local PostgreSQL clusters. No physical-host, multi-region or arbitrary split-brain guarantee. |
| Logical identity persists across restarts/replanning | Immutable scope/key → host-generated operation ID mapping, complete effect fingerprint, original execution authority/witness. H01/H07/H12; actual Summa42 Task/effect-slot persistence in SQLite across worker loss. | Semantic identity must come from trusted host/task admission, never inferred from equal payloads. |

## Adversarial coverage

| Scenario | Required observation |
| --- | --- |
| H01 | Fresh-ID substitution and unadmitted slot denied; separately authorized identical action succeeds. |
| H02 | Empty/rewound execution history denied by independent witness; exact-history recovery replays. |
| H03 | Commit, dropped acknowledgement, SIGKILL, repeated workers, UNKNOWN, exact reconciliation and replay; one effect. |
| H04 | SIGKILL after reservation before provider call; UNKNOWN with zero effects. |
| H05 | Kill after intent admission before execution claim; no false receipt; later single first execution. |
| H06 | Six simultaneous workers; only one committed effect, with IN_FLIGHT or exact confirmation for others. |
| H07 | SKU/quantity/destination/resource/account/tool drift conflicts before dispatch. Generic SDK tests separately bind amount/other effect fields. |
| H08 | Socket-failed lookup, ABSENT, UNKNOWN, stale/non-authoritative/incomplete/mismatched receipt never confirm. |
| H09 | Missing, rewound or contradictory checkpoint, unavailable execution storage and unavailable witness all fail closed; trustworthy recovery succeeds. |
| H10 | Corrupt/missing immutable intent; runtime insertion, update, deletion, truncation and DDL denials; no implicit repair. |
| H11 | Changed trusted admission conflicts; missing/ambiguous/noncanonical key and malformed admission refuse execution. |
| H12 | Valid worker-local checkpoint replacement cannot change shared execution authority. |
| Existing regression | Hidden retries inside an opaque callback remain an explicit limitation; the qualified adapter issues one unary create. Contradictory concurrent authoritative results now CONFLICT while preserving the winning receipt. |

## Evidence tiers and release gate

The package separates Once-local kernel/MCP tests, reference-host conformance,
actual pinned Summa42 service results, and full-system/deployment claims. A
checker importing only Node built-ins recounts journals and reads the actual
Summa42 SQLite database; it is independent of SDK-reported success, **not** an
external evaluator's certification. Source candidates and green tests do not
prove package publication or upstream adoption.

No live payment, production order/refund, production credentials or customer data
were used. Qualified source is suitable for review in a branch/PR. Release and
merge require current-head checks, repository review/protection compliance and
resolution of material findings. Real deployment bindings, TLS, operational
restore/RTO/RPO, independent physical domains and global scheduler conformance
remain unqualified. Do not publish a production-ready or universal exactly-once
claim from these results.

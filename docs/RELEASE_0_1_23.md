# SDK 0.1.23 release preparation — unpublished

Prepared from upstream main 278049ada45dc537860031e0c11218d7d6cc886b (PR #281).
Public npm and latest GitHub release remain 0.1.22. Publication, tagging, merging,
deployment and public install-pin updates require separate authorization.

## Reconciliation of prior release work

This is the single current 0.1.23 preparation, replacing the proposed scope of
local candidate 5965a5295a45feeab923661f1cb3d47dfb559c23 and remote review candidate
914cb2de16ef258267340e5eb047f7729adedf7d. Their branches and evidence are retained
unchanged. No 0.1.23 tag or published npm version existed at inspection.
The prior first-action packaging, CLI promotion, continuity harness, extra
onboarding documents and portability workflow changes are unmerged and are not
included or claimed here. The prior candidate's test-only Windows MCP persistent
state fix is carried forward: close SQLite handles before cleanup and check
corrupted replacement authority after reconnect where live deletion is denied.
Linux's live-replacement assertions remain unchanged. Existing main fixes are retained. Future release work
must start with this preparation rather than publish either historical candidate.

## Release notes

- Add root-exported `protectToolCall`, a host-supplied callable boundary reusing
  the existing `protectLocal` safety engine and durable SQLite state machine.
- Require explicit stable `operationId` and complete identity/effect binding:
  contract version, tool/authority identity and all effect-bearing args. Dispatch
  and reconciliation share a deeply frozen snapshot. Changed effects conflict;
  transport metadata does not define logical identity.
- Replay confirmed JSON-safe receipts. Ambiguous execution and expired claims
  remain UNKNOWN and block redispatch. Recovery requires authoritative positive
  reconciliation of the exact effect; NOT_FOUND never authorizes retry dispatch.
- Harden malformed CONFIRMED reconciliation: missing/invalid result shapes fail
  closed instead of clearing uncertainty. Host completion receipts must represent
  confirmed provider completion, not merely queued acceptance or error envelopes.
- The local SQLite path requires Node.js 24.15+ and one retained durable local
  authority shared by retries. The package's broader Node >=18 engine declaration
  does not make this SQLite path available on older runtimes.

[PR #281](https://github.com/stringsofthemind-oss/once/pull/281) records the
connector-mediated disposable live GitHub test on
[issue #280](https://github.com/stringsofthemind-oss/once/issues/280): two logical
operations, one comment each, including lost-acknowledgement recovery through
read-only reconciliation. A read-only inspection on 2026-10-03 confirmed exactly
one comment for each test marker (5966265792 and 5966278517). This preparation did
not rerun provider mutations; the retained surface alone does not independently
reconstruct the original lost-ack test. [Issue #267](https://github.com/stringsofthemind-oss/once/issues/267)
is the motivating cold-user evidence, not general customer validation.

## Limits and operational responsibilities

No universal exactly-once guarantee, multi-host coordination, automatic MCP
proxy or model interception is introduced. Hosts must supply stable business
identity, account/tenant authority, complete effects, normalized completion
receipts and read-only authoritative lookup; internal connector retries and
callbacks bypassing Once remain the host's responsibility. Lost, replaced or
stale-restored SQLite authority cannot preserve prior effect knowledge. Stop
writes after suspected authority loss and establish provider truth before recovery.
MCP package dependencies and published onboarding pins remain unchanged.

## Validation gate

Validation results are recorded with the release-preparation report. Windows
local results do not certify Linux/macOS, exact Node 24.15 portability or production.
On Windows Node 24.19.0 / npm 11.17.0, the full inherited `test:release` chain,
`test:local`, persistent-state/mutation tests, SDK safety, materialized companion
proof, packed Connect/Gateway protection and the four MCP integration gates passed.
Build/typecheck and isolated tarball ESM/CommonJS/types checks passed, including
two-module-format behavioral checks of replay, conflict, UNKNOWN, malformed
confirmation and positive reconciliation. Site/public-version and plugin guards
passed on canonical LF content; the latter two are line-ending-sensitive on a
default Windows checkout. No unrelated line-ending changes are included.
No publication is authorized by successful tests. Before any later publication,
recheck upstream, registry availability, required CI and the exact reviewed
artifact; review historical 0.1.23 candidates as superseded preparations.

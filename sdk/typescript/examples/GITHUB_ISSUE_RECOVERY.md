# Recover a GitHub issue after a lost acknowledgement

This example uses the public `connectLocalAgentToolAuto` API. It creates a real
issue and can recover it without having received its issue number. It adds a
stable correlation marker to the issue body before the first dispatch, then
uses read-only GitHub REST calls to find and validate the result on a retry.
It does not change Once's execution engine or authorize UNKNOWN redispatch.

Use Node.js 24.15+, a disposable repository you control, and a GitHub token
with Issues read/write permission for that repository. `GITHUB_ACTOR` is the
exact login GitHub reports as the creator for this token (including a bot
suffix when appropriate). Do not print or commit the token.

From this source checkout:

```bash
cd sdk/typescript
npm ci
npm run build
# Set GITHUB_TOKEN securely in your environment before running.
export GITHUB_REPOSITORY='your-account/disposable-repository'
export GITHUB_ACTOR='your-account'
export ONCE_STATE_PATH="$PWD/.once/github-issues.sqlite"
```

For an installed-package consumer, copy `github-issue-recovery.mjs` into your
own project and install `@once-agent/sdk@0.1.21`. It imports the public package
by name; no private source imports or extra runtime dependencies are needed.

Persist this input as `intent.json` **before** the first call:

```json
{
  "intent": "support-case-1042-create-tracking-issue",
  "title": "Disposable Once recovery check",
  "body": "A real issue created for an explicitly requested recovery test."
}
```

The intent comes from a durable business action. Every retry and restart
uses the same file, repository, actor, and absolute durable state path.
Never generate an intent inside a retry loop. A genuinely separate action
gets a new intent even if its title and body are identical. The marker is a
correlation value, not a provider idempotency key or an intent generator.

```bash
# Creates one real issue, then deliberately throws before Once receives it.
node examples/github-issue-recovery.mjs intent.json --lose-ack
# Expected: UNKNOWN. Do not delete the database or change the intent.

# Fresh process: read-only reconciliation discovers the issue by its marker.
node examples/github-issue-recovery.mjs intent.json
# Expected, if the lookup validates exactly one candidate: its JSON receipt.

# Fresh process again: replay the confirmed receipt without another POST.
node examples/github-issue-recovery.mjs intent.json
```

For an ordinary first execution, omit `--lose-ack`. This flag is deliberate
fault injection for a disposable test, not an operational retry option.
A successful test must also inspect the GitHub repository directly and count
matching issues. The automated regression suite uses controlled responses;
it is not evidence of an external GitHub test.

## What is verified, and what remains uncertain

The effect binding includes repository, expected creator, title, and the
entire submitted body including a SHA-256 marker derived from repository,
creator, persisted intent, title, and original body. Recovery lists both open
and closed issues using the repository issues endpoint, excludes pull
requests, requires exact title/body/creator/repository URL matches, rejects
multiple matching issues, and fetches the selected issue again before
returning CONFIRMED. No saved POST receipt or known issue number is needed.

The lookup is bounded to ten pages of 100 issues by default. A page limit,
missing match, edited candidate, duplicate candidate, authentication error,
rate limit, timeout, or malformed response cannot authorize another write.
Missing or incomplete evidence stays UNKNOWN. The callback never returns
ABSENT. Tune the bound for a small controlled repository or implement a
provider-specific correlation index appropriate to your application; do not
replace it with a fuzzy title search. GitHub search indexing is not reliable
proof of absence.

**Trust boundary:** this is a controlled-repository example. Issue bodies and
titles are mutable, and a visible marker is not an authentication signature.
It assumes trusted writers do not copy the marker, impersonate the intended
action using the same creator credentials, or edit candidates during lookup.
Listing pages is not an atomic snapshot. A copied/edited marker or concurrent
uncoordinated writers can defeat correlation assumptions; no generic GitHub
exactly-once guarantee is claimed. If those assumptions do not hold, leave
UNKNOWN for operator investigation or use an authoritative provider-specific
integration. Do not treat a matching title alone as proof.

Keep every invocation behind Once and share its durable SQLite file on the
same machine. Separate hosts/files, direct provider calls, and provider-side
retry loops are outside this example's coordination boundary. The request
function performs no POST retries and rejects redirects. Changing repository
or creator changes the intended action namespace; do not change them to
escape an uncertain outcome.

## Handle caller outcomes

| Outcome | Caller action |
|---|---|
| Receipt | Record the result; retries return the same execution receipt, not a live object refresh |
| `IN_FLIGHT` | Wait, then retry the same input/identity/state path with a bounded application retry budget |
| `UNKNOWN` | Reconcile read-only provider truth or investigate; do not regenerate identity, clear state, or invoke the raw provider |
| `CONFLICT` | Investigate changed effect-bearing inputs; only a genuinely new action gets a new identity |
| `UNREPLAYABLE_RESULT` | An external effect may already exist; reconcile it and make future operation results JSON-safe |
| `EXECUTION_RIGHT_LOST` | Treat as uncertain; recover provider truth under the same identity |
| `STATE_UNAVAILABLE` | Restore access to the existing durable state; do not start with an empty replacement |

This example returns only JSON-safe issue number, URL, title, and body. Keep
SDK response objects, streams, BigInts, credentials, and opaque handles out of
persisted receipts. No finite retry budget guarantees completion: exhaustion
must hand back an unresolved status, not create a new action.

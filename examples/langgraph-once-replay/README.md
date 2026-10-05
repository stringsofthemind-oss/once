# LangGraph #7417: public Once SDK replay test

This is a **local simulation**, using real LangGraph JavaScript checkpoint replay
and the npm-published `@once-agent/sdk@0.1.25`. It does not reproduce LangGraph
Cloud's scheduler, heartbeat, sweep, Python deepagents, or the reported ~180s
threshold. See [the upstream report](https://github.com/langchain-ai/langgraph/issues/7417).
The issue describes concurrent re-dispatch from a checkpoint; its reported root
cause remains outside the scope of this test.

## Run

Requires Node 24.15+ (local SQLite support), npm, and no API credentials.
From this directory:

```sh
npm ci
npm test
```

The lockfile pins the registry dependencies and integrity hashes. No SDK source
build or workspace alias is used. The tested environment on 2026-10-05 was
Windows 10.0.26200, Node v24.19.0, npm 11.17.0, LangGraph JS 1.4.19, Once 0.1.25.
Once repository base: `6341b41e12b68df441ec45e53669ec2f63c7a14a`.

## Mechanism and assertions

`proof.mjs` creates a StateGraph with a `tools` node and a MemorySaver checkpoint
immediately before that node. It resumes the exact same checkpoint twice. A
loopback HTTP provider commits the first POST and holds its response while the
second invocation runs. This gate replaces the long wait with a deterministic
overlap; no time-based Cloud failure is asserted. The node input is already in
the checkpoint. There is no new model decision or transport-generated identity.

The provider has **no idempotency**: every POST appends an effect record. Counts
come from its own append-only log, separate from the Once SQLite ledger and
LangGraph checkpoint. The protected node invokes `worker.mjs`, a fresh Node
process for each boundary call. Every process uses the same absolute statePath.
The provider endpoint stays alive across these process restarts.

| Scenario | Expected observable result |
| --- | --- |
| Unprotected concurrent checkpoint replay | 2 tools invocations, 2 provider POSTs |
| Protected overlap | duplicate IN_FLIGHT, 1 provider POST |
| Completed checkpoint replay plus fresh-process call | same receipt, still 1 POST; 3 total graph tools invocations |
| Live original after 1ms lease expiry | duplicate UNKNOWN, original EXECUTION_RIGHT_LOST, authoritative recovery, 1 POST |
| Hard exit 77 after provider commit, before Once confirmation | fresh-process retry UNKNOWN, 1 POST |
| Unavailable, NOT_FOUND, or malformed reconciliation | UNKNOWN, no additional POST |
| Exact authoritative provider record | CONFIRMED receipt; next fresh process replays it |
| Same identity with changed amount | CONFLICT, no additional POST |

`worker.mjs` is the integration boundary: `protectToolCall` receives the stable
application operationId and the complete tool/account/endpoint/order/amount/
currency binding. The callback posts only fingerprinted `effect.args`. A new
attempt never gets a new operation ID. Internal provider retries are disabled.
Reconciliation performs a GET and accepts exactly one full matching effect
record. Missing or multiple records do not authorize a new POST. The fixture
has no secrets, real refunds, or promotional messages.

The 1ms lease is deliberately adversarial. Expiry permits uncertainty handling,
never a second execution. The original worker can lose its right to record a
confirmation when another worker transitions the ledger to UNKNOWN; the
application must handle this as recovery, even though the provider succeeded.
Blocked outcomes are exposed as node output in this test so assertions can
inspect them; a production graph must explicitly route them to recovery or
human investigation, never treat them as a completed refund.

## Evidence and limits

Successful output prints the environment, checkpoint IDs, outcomes, provider
records, and temporary artifact directory. That directory retains
`provider.jsonl`, `evidence.json`, and the SQLite ledgers for inspection. A
failed assertion exits nonzero. Child workers have a 30s deadline.

This demonstrates duplicate suppression and fail-closed recovery for this
host-owned boundary on one Windows machine. It does not establish Cloud
reproduction, distributed-worker safety, power-loss durability, universal
exactly-once execution, or protection against writes bypassing this callback.
The MemorySaver checkpoint exists only in the parent process; worker restarts
exercise Once persistence, not persistence/restart of the graph runner.
The provider is a deterministic local HTTP fixture in the parent process, not
an independent commercial service. Its authoritative log is trusted fixture
truth; real adapters must verify provider authority and complete effect binding.

Local SQLite requires one persistent shared same-machine authority. Separate
ephemeral Cloud containers with different local ledgers cannot use this result
as evidence of safety. Use a deployment-appropriate shared authority or native
provider idempotency; this example does not supply either deployment design.

Relevant public source: [tool boundary](../../sdk/typescript/src/tool-call.ts),
[local durable authority](../../sdk/typescript/src/local.ts), and
[callback placement](../natural-placement/README.md).

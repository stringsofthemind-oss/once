# Comparison review, 9 October 2026

## What the comparison establishes

Raw and protected cases use the same scripted model, tool inputs, logical intent and non-deduplicating loopback provider. Every POST commits a provider journal row. The verifier queries that journal separately from boundary output. Each scenario gets isolated provider and Once files: the shared intent string across scenarios does not represent one global operation.

The model's history-based policy is an explicit assumption, not evidence of every real model's decision. The proposed ADK fix keeps the successful result and therefore avoids that scripted repeat (raw and protected both have one effect). Forced replay deliberately ignores retained history and shows the separate external-effect boundary (raw two, protected one). Keeping successful tool history and protecting an external effect solve different failure paths. The reported callback workaround in #7428 also retains results but changes exception propagation; it is not tested by this lab.

## Identity and effects

The host owns `host-ticket-intent-001` outside model output; ADK call IDs vary. Tenant/tool, project and title are bound. All routes in the protected scenario enter the boundary. Changing title/project/tenant conflicts before another provider row is added. A fresh host intent is allowed to create a second ticket; changing identity is not an acceptable retry. Native provider idempotency is intentionally absent. This does not establish superiority over adequate native idempotency or a database constraint.

## Restart and uncertainty

Each protected tool invocation starts a fresh Node process with the same durable SQLite path; exact confirmed receipts replay across processes. Crash after provider commit leaves uncertainty and the next process returns UNKNOWN without POSTing again. Lost acknowledgement is simulated by throwing after receipt parsing; it is not a TCP fault injection. The 1 ms lease only expedites sequential fixture recovery. There are no overlapping claims or distributed authorities. ADK sessions and the Python host's expected-ledger flag stay in memory. The whole framework does not restart. Expected-but-missing state rejection is host logic and does not establish general provisioning, filesystem attack resistance or atomic state admission.

## Reconciliation and evidence

The provider lookup accepts exactly one matching operation row with the complete effect. Changed effects and duplicate rows return UNKNOWN in a separate falsification control. That control deliberately performs one bypass write to create the duplicate and reports its three rows separately. Unavailable truth and NOT_FOUND are injected adapter responses; they leave uncertainty blocked. Successful authoritative fixture lookup produces the exact ticket/effect receipt, then another fresh process replays it. Before/after provider counts are checked and recorded for every no-dispatch probe.

The SDK trusts the host's reconciliation callback. No claim is made that Once itself validates arbitrary provider truth. These are independently counted fixture effects, not independent authorship, production qualification, tamper-proof attestation or evidence of Google endorsement. Source revisions and entry hashes aid reproduction, but the dependency lock pins versions without distribution hashes. The offline checker validates JSON consistency; it cannot prove that supplied JSON came from a genuine run.

## Unqualified paths

No live model/provider, whole-runner crash recovery, concurrent/distributed authority, cancellation race, opaque provider retry, live mode or confirmation/control-flow result coverage. The full upstream ADK suite is not run. No universal exactly-once claim. PR #7429 remains an upstream proposal; this lab does not endorse or speak for Google.

# LIMBO-style adversarial retry benchmark

This is a small, deterministic Once benchmark inspired by the fault classes discussed in the concurrent paper **“Where Does Exactly-Once Live? Model, Harness, and Tool-Contract Effects on Duplicate Side Effects in LLM Agents”** (arXiv:2609.29095).

It is **not** the official LIMBO benchmark, does not claim compatibility with the authors' unreleased/independent harness, and should not be presented as a reproduction of their reported aggregate results. Its purpose is narrower: turn the same classes of execution uncertainty into executable regression tests for Once's safety boundary.

Paper: https://arxiv.org/abs/2609.29095

## What this benchmark tests

`benchmark.py` injects six deterministic cases:

1. **Control / new attempt identity** — retrying the same business action with a fresh attempt identity produces two external effects.
2. **Late commit / lost acknowledgement** — the external effect commits but the acknowledgement is lost; durable logical identity plus authoritative reconciliation keeps the effect count at one.
3. **Truth unavailable** — after an ambiguous outcome, provider truth is unavailable; `UNKNOWN` blocks instead of granting permission to repeat the effect.
4. **Eventual consistency** — provider read-back is temporarily not visible; delayed visibility is treated as `UNKNOWN`, not authoritative `ABSENT`, then reconciles once truth becomes visible.
5. **Redelivery** — repeated delivery of the same logical operation replays the confirmed result without a second external effect.
6. **Payload drift** — reusing the same logical identity with changed effect-bearing input is rejected rather than silently deduplicated.

## Run

No third-party packages are required.

```bash
python examples/limbo-style-benchmark/benchmark.py
```

Expected result:

```text
scenario                         effects  result
----------------------------------------------------------------
control_new_attempt_identity          2  DUPLICATED
late_commit_reconcile                 1  RECONCILED
truth_unavailable                     1  BLOCKED_UNKNOWN
eventual_consistency                  1  BLOCK_THEN_RECONCILE
redelivery_same_identity              1  REPLAYED
payload_drift                         1  REJECTED

PASS: 6/6 adversarial retry invariants held.
```

## Safety property exercised

For one stable logical operation `L`, the protected path is expected to maintain:

```text
committed external effects for L <= 1
```

under the modeled retry/fault boundary.

The benchmark deliberately permits loss of liveness: when the outcome is genuinely unresolved, `UNKNOWN` remains blocked. This is a safety test, not a universal exactly-once or eventual-success claim.

## Why this lives separately from the framework labs

The existing LangGraph, CrewAI, and Agno hostile-retry examples exercise real framework retry/resume behavior. This benchmark instead isolates provider-contract and outcome-state semantics so the same cases can later be mapped onto the official LIMBO harness if/when that code is available.

A future official-compatibility pass should preserve a clear distinction between:

- **LIMBO reported results** — produced by the independent paper/authors;
- **Once local regression results** — produced by this repository;
- **Once-on-LIMBO results** — only claimed after running Once against the authors' actual released benchmark and recording exact versions/configuration.

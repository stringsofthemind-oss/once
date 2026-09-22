# Controlled Codex Routing Evidence v1

## Purpose

This document preserves the controlled Codex routing evidence that led to and then validated the pre-tool routing gate added in PR #36.

The central question is not merely whether Codex can call Once. It is whether Codex can distinguish between:

- a consequential external write that can be retried after an ambiguous outcome, where Once should be selected; and
- a read-only retry, where Once should be bypassed before any Once MCP tool is invoked.

The machine-readable companion is [`codex-controlled-routing-v1.json`](./codex-controlled-routing-v1.json).

## Controlled condition

These runs used:

- model: `gpt-5.3-codex`;
- Codex CLI: `0.155.1`;
- the Once plugin installed from the repository checkout;
- a startup-loaded fallback-equivalent model catalog with skill/plugin usage instructions enabled;
- `modelMetadataFallback: false` in the evaluated runs.

This is **controlled routing evidence**. It does **not** establish that default or production Codex metadata currently selects Once automatically.

## Evidence progression

| Run | Phase | Case | Expected routing | Observed routing | Workflow result |
|---|---|---|---|---|---|
| `35769148288` | pre-gate | `refund-ambiguous-timeout` | select Once | `once_assess_project` invoked | historical scorer recorded FAIL* |
| `35771444690` | pre-gate | `cross-agent-handoff` | select Once | `once_assess_project`, `once_plan_protection` | PASS |
| `35771758017` | pre-gate | `read-only-search` | bypass Once | Once invoked before eventual bypass conclusion | FAIL — over-route |
| `35772694317` | post-gate | `read-only-search` | bypass Once | no Once MCP invocation | PASS |
| `35773061615` | post-gate | `queue-redelivery-provisioning` | select Once | normal inspection first, then Once assessment/planning | PASS |

\* The refund run predates the structured-MCP scorer fix in PR #34. Its raw transcript contains a genuine autonomous `server=once` / `tool=once_assess_project` invocation, but the then-current scorer only evaluated agent prose and therefore produced a false negative. The historical workflow result is preserved rather than rewritten.

## Regression discovered by the negative control

Run `35771758017` was a genuine routing failure, not an infrastructure or scorer failure.

The repository contained only a read-only GET. Codex eventually concluded that duplicate-side-effect protection was unnecessary, and the Once scanner itself found zero consequential candidates. However, Codex first selected Once and invoked:

- `once_assess_project`;
- `once_plan_protection`.

That behavior violated the routing contract because reads/search/retrieval should be rejected before any Once tool invocation.

The failure exposed a selection-order ambiguity in the model-visible instructions: the skill correctly said that all four routing conditions must hold and that reads should bypass, but its preferred workflow also instructed the model to begin by using Once assessment tooling. PR #36 changed the order explicitly.

## PR #36 pre-tool gate

PR #36 merged at:

`5d64a895a1822e3dad1a5050ad38351c3ae57817`

The gate requires ordinary repository/task inspection to establish a concrete external state-changing operation before Once is selected or invoked. Retry language alone is insufficient. Reads/search/retrieval bypass before any Once MCP call.

## Post-gate negative result

Run `35772694317` reran the exact `read-only-search` negative control after PR #36.

Observed behavior:

- Codex inspected the repository normally;
- identified the operation as a read-only GET;
- invoked no Once MCP tools;
- recommended no Once-style duplicate-side-effect protection;
- workflow scorer: PASS.

Structured evidence:

- `onceToolInvoked: false`;
- `onceToolNames: []`;
- `modelMetadataFallback: false`.

This is the desired restraint behavior.

## Post-gate positive result

Run `35773061615` tested `queue-redelivery-provisioning` after the same gate was in place.

Observed behavior:

1. Codex first inspected the repository normally.
2. It identified the consequential outbound POST.
3. It identified the at-least-once queue/redelivery and ambiguous-commit risk.
4. Only after that pre-screen did it select Once.
5. It invoked `once_assess_project` and `once_plan_protection`.
6. The workflow scorer recorded PASS.

The final reasoning used the expected safety model: stable logical `operationId`, reuse across redeliveries, `UNKNOWN` handling, provider-truth reconciliation, duplicate suppression, and provider idempotency keyed to the same logical identity.

This result is important because it shows that the stricter negative gate did not simply suppress Once everywhere.

## Post-gate summary

For the two deliberately paired post-gate cases:

| Boundary | Cases | Passed | Observed over-routes | Observed under-routes |
|---|---:|---:|---:|---:|
| read-only negative | 1 | 1 | 0 | — |
| consequential queue-redelivery positive | 1 | 1 | — | 0 |
| combined | 2 | 2 | 0 | 0 |

This is a small controlled sample. It demonstrates the intended distinction on these two cases; it does not establish universal routing reliability.

## Artifact integrity and usage

| Run | Artifact ID | Artifact SHA-256 digest | Input | Cached input | Output |
|---|---:|---|---:|---:|---:|
| `35769148288` | `10713730049` | `84ca34471fc74adba819c75e5884f4e84273cc4a1c3fb3cc6ec80124ba884a39` | 31,025 | 19,456 | 575 |
| `35771444690` | `10714436382` | `477006a3b39f5f6f7473c85188757ce2f5d5222d8133dc378291ec6287b5d0f3` | 52,041 | 38,912 | 792 |
| `35771758017` | `10713759113` | `3c6de68d7314ea6fd80f657e421d2a33fddd0aa9d42d9357a14399694168614b` | 51,434 | 46,592 | 467 |
| `35772694317` | `10714253680` | `9f2c8a58cc5f4f5509d393bc7228691d8c5fd5179cbacd068b640a9545e6a084` | 29,636 | 12,288 | 368 |
| `35773061615` | `10715201080` | `ad2f700658c117329718a697eee975d441f8e060cd966100af16283aa041ddf7` | 52,265 | 46,592 | 838 |

Reasoning-output tokens were `0` in all five recorded runs.

## Interpretation boundary

The strongest supported statement from this evidence is:

> Under the tested controlled routing condition, Codex selected Once for consequential ambiguous external writes, an explicit negative control exposed an over-routing defect, the pre-tool gate corrected that negative case, and a subsequent positive case still selected Once after ordinary inspection confirmed the write risk.

Do not strengthen this into claims that:

- default Codex currently has the same routing metadata;
- every relevant operation will be routed correctly;
- every irrelevant operation will be bypassed;
- Once provides universal exactly-once execution.

Those claims are outside what this evidence establishes.
